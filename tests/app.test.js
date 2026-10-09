const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const path = require("node:path")
const { ReadableStream } = require("node:stream/web")
const test = require("node:test")
const { TextDecoder, TextEncoder } = require("node:util")
const vm = require("node:vm")

const appSource = readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
const encoder = new TextEncoder()
const conversationStorageKey = "followAlongOllama.conversation"

// Reuse the same storage across app instances to simulate reloading one tab.
function createSessionStorage(initialItems = {}) {
    const items = new Map(Object.entries(initialItems))
    const failures = {}

    function checkFailure(method) {
        if (failures[method]) {
            throw failures[method]
        }
    }

    return {
        failures,
        getItem(key) {
            checkFailure("getItem")
            return items.get(String(key)) ?? null
        },
        setItem(key, value) {
            checkFailure("setItem")
            items.set(String(key), String(value))
        },
        removeItem(key) {
            checkFailure("removeItem")
            items.delete(String(key))
        }
    }
}

// Supply only the browser features this app uses, without parsing HTML strings.
class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase()
        this.children = []
        this.parentElement = null
        this.insertionCount = 0
        this.attributes = new Map()
        this.listeners = new Map()
        this.disabled = false
        this.hidden = false
        this.className = ""
        const styleProperties = new Map()
        this.style = {
            setProperty(name, value) {
                styleProperties.set(name, String(value))
            },
            getPropertyValue(name) {
                return styleProperties.get(name) || ""
            }
        }
        this.focusCount = 0
        this._textContent = ""
        this._value = ""
    }

    get textContent() {
        return this._textContent + this.children.map((child) => child.textContent).join("")
    }

    set textContent(value) {
        this._textContent = String(value)
        for (const child of this.children) {
            child.parentElement = null
        }
        this.children = []
    }

    set innerHTML(value) {
        throw new Error("Conversation content must use textContent instead of innerHTML")
    }

    get value() {
        if (this.tagName === "SELECT" && this._value === "") {
            return this.children[0]?.value || ""
        }
        return this._value
    }

    set value(value) {
        this._value = value
    }

    append(...children) {
        for (const child of children) {
            child.remove()
            child.parentElement = this
            child.insertionCount += 1
            this.children.push(child)
        }
    }

    prepend(...children) {
        for (const child of children) {
            child.remove()
            child.parentElement = this
            child.insertionCount += 1
        }
        this.children.unshift(...children)
    }

    remove() {
        if (this.parentElement !== null) {
            const siblings = this.parentElement.children
            siblings.splice(siblings.indexOf(this), 1)
            this.parentElement = null
        }
    }

    replaceChildren(...children) {
        this.textContent = ""
        this.append(...children)
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value))
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || []
        listeners.push(listener)
        this.listeners.set(type, listeners)
    }

    emit(type) {
        const event = {
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true
            }
        }
        const results = (this.listeners.get(type) || []).map((listener) => listener(event))
        if (type === "submit") {
            assert.equal(event.defaultPrevented, true)
        }
        return Promise.all(results)
    }

    focus() {
        this.focusCount += 1
    }
}

function messageArticle(entry) {
    return entry.children[0].children[0]
}

function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve))
}

// Advance request deadlines without making the suite wait several real minutes.
function createClock() {
    const timers = new Map()
    let currentTime = 0
    let nextId = 1

    return {
        setTimeout(callback, delay) {
            const id = nextId++
            timers.set(id, { callback, due: currentTime + delay })
            return id
        },
        clearTimeout(id) {
            timers.delete(id)
        },
        async advance(milliseconds) {
            const targetTime = currentTime + milliseconds
            while (true) {
                const next = [...timers.entries()]
                    .filter(([, timer]) => timer.due <= targetTime)
                    .sort((first, second) => first[1].due - second[1].due)[0]
                if (!next) {
                    break
                }
                const [id, timer] = next
                currentTime = timer.due
                timers.delete(id)
                timer.callback()
                await flushPromises()
            }
            currentTime = targetTime
            await flushPromises()
        },
        pendingCount() {
            return timers.size
        }
    }
}

function jsonResponse(data) {
    return { ok: true, json: async () => data }
}

function streamResponse(chunks) {
    return {
        ok: true,
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
                }
                controller.close()
            }
        })
    }
}

function assistantResponse(content) {
    return streamResponse([JSON.stringify({ message: { role: "assistant", content }, done: true }) + "\n"])
}

// Keep a real stream open so tests can inspect the UI between individual chunks.
function controlledReply() {
    let controller
    let cancelled = false
    const body = new ReadableStream({
        start(streamController) {
            controller = streamController
        },
        cancel() {
            cancelled = true
        }
    })
    return {
        response: { ok: true, body },
        write(data) {
            controller.enqueue(typeof data === "string" ? encoder.encode(data) : data)
        },
        writeLine(data) {
            this.write(JSON.stringify(data) + "\n")
        },
        close() {
            controller.close()
        },
        isCancelled() {
            return cancelled
        }
    }
}

async function createApp(modelResponse = jsonResponse({ models: [{ name: "test-model" }] }), live = false,
    storage = createSessionStorage()) {
    const elementTags = {
        promptForm: "form",
        prompt: "input",
        model: "select",
        submitPrompt: "button",
        clearConversation: "button",
        stopReply: "button",
        error: "p",
        status: "p",
        storageNotice: "p",
        conversation: "div",
        emptyConversation: "p"
    }
    const elements = Object.fromEntries(Object.entries(elementTags).map(([id, tagName]) => [
        id,
        new FakeElement(tagName)
    ]))
    const requests = []
    const errors = []
    const modelRequests = []
    const clock = createClock()

    const fetch = (url, options) => {
        if (url.endsWith("/api/tags")) {
            modelRequests.push({ url, options })
            if (live) {
                return globalThis.fetch(url, options)
            }
            return typeof modelResponse === "function"
                ? modelResponse()
                : Promise.resolve(modelResponse)
        }
        assert.equal(url, "http://localhost:11434/api/chat")
        if (live) {
            requests.push({ options, payload: JSON.parse(options.body) })
            return globalThis.fetch(url, options)
        }
        return new Promise((resolve, reject) => {
            requests.push({ options, payload: JSON.parse(options.body), resolve, reject })
        })
    }

    const browserContext = {
        document: {
            getElementById: (id) => elements[id],
            createElement: (tagName) => new FakeElement(tagName)
        },
        fetch,
        AbortController,
        TextDecoder,
        setTimeout: live ? setTimeout : clock.setTimeout,
        clearTimeout: live ? clearTimeout : clock.clearTimeout,
        console: { error: (...args) => errors.push(args) }
    }
    // Access to sessionStorage itself can throw when browser privacy rules block it.
    Object.defineProperty(browserContext, "sessionStorage", {
        get: () => typeof storage === "function" ? storage() : storage
    })
    vm.runInNewContext(appSource, browserContext, { filename: "app.js" })

    // Model loading begins at script startup and finishes across promise turns.
    await flushPromises()
    assert.equal(modelRequests.length, 1)

    return {
        elements,
        requests,
        errors,
        modelRequests,
        clock,
        storage,
        submit(prompt) {
            elements.prompt.value = prompt
            return elements.promptForm.emit("submit")
        },
        clear() {
            return elements.clearConversation.emit("click")
        },
        stop() {
            return elements.stopReply.emit("click")
        },
        transcript() {
            return elements.conversation.children.map((entry) => {
                const message = messageArticle(entry)
                return {
                    label: message.children[0].textContent,
                    content: message.children[1].textContent
                }
            })
        },
        history() {
            // Read the newest-first UI chronologically for context and retry checks.
            return this.transcript().reverse()
        }
    }
}

async function completeTurn(app, prompt, reply) {
    const pending = app.submit(prompt)
    app.requests.at(-1).resolve(assistantResponse(reply))
    await pending
}

test("follow-ups send chronological context and render literal text newest first", async () => {
    const app = await createApp()
    const prompt = '<img src="x" onerror="alert(1)"> Explain this code'
    const reply = "Use textContent.\n<script>alert('example')</script>"

    const firstSubmit = app.submit(`  ${prompt}  `)
    const firstRequest = app.requests[0]
    assert.equal(firstRequest.options.method, "POST")
    assert.equal(firstRequest.options.headers["Content-Type"], "application/json")
    assert.deepEqual(firstRequest.payload, {
        model: "test-model",
        messages: [{ role: "user", content: prompt }],
        stream: true
    })
    assert.deepEqual(app.history(), [{ label: "You", content: prompt }])
    assert.equal(app.elements.emptyConversation.hidden, true)
    assert.equal(app.elements.submitPrompt.disabled, true)
    assert.equal(app.elements.model.disabled, true)
    assert.equal(app.elements.prompt.disabled, true)
    assert.equal(app.elements.clearConversation.disabled, false)
    assert.equal(app.elements.stopReply.hidden, false)
    assert.equal(app.elements.conversation.attributes.get("aria-busy"), "true")

    firstRequest.resolve(assistantResponse(reply))
    await firstSubmit
    const secondSubmit = app.submit("What happens next?")
    assert.deepEqual(app.requests[1].payload.messages, [
        { role: "user", content: prompt },
        { role: "assistant", content: reply },
        { role: "user", content: "What happens next?" }
    ])
    app.requests[1].resolve(assistantResponse("Here is the follow-up."))
    await secondSubmit

    assert.deepEqual(app.transcript(), [
        { label: "Assistant (test-model)", content: "Here is the follow-up." },
        { label: "You", content: "What happens next?" },
        { label: "Assistant (test-model)", content: reply },
        { label: "You", content: prompt }
    ])
    for (const entry of app.elements.conversation.children) {
        const message = messageArticle(entry)
        assert.equal(message.children[1].tagName, "P")
        assert.equal(message.children[1].children.length, 0)
    }
    assert.equal(app.elements.submitPrompt.disabled, false)
    assert.equal(app.elements.model.disabled, false)
    assert.equal(app.elements.prompt.disabled, false)
    assert.equal(app.elements.status.textContent, "")
    assert.equal(app.elements.stopReply.hidden, true)
    assert.equal(app.elements.conversation.attributes.get("aria-busy"), "false")
    assert.equal(app.clock.pendingCount(), 0)
})

test("streaming reuses the newest bubble and keeps earlier entries attached", async () => {
    const app = await createApp()
    await completeTurn(app, "Earlier question", "Earlier answer")
    const earlierEntries = [...app.elements.conversation.children]
    const stream = controlledReply()
    const pending = app.submit("Explain more")
    const questionEntry = app.elements.conversation.children[0]

    assert.deepEqual(app.transcript(), [
        { label: "You", content: "Explain more" },
        { label: "Assistant (test-model)", content: "Earlier answer" },
        { label: "You", content: "Earlier question" }
    ])
    assert.deepEqual(app.requests[1].payload.messages, [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Explain more" }
    ])
    app.requests[1].resolve(stream.response)
    stream.writeLine({ message: { content: "First " }, done: false })
    await flushPromises()

    const replyEntry = app.elements.conversation.children[0]
    const replyArticle = messageArticle(replyEntry)
    const replyParagraph = replyArticle.children[1]
    assert.equal(replyParagraph.textContent, "First ")
    assert.equal(app.elements.submitPrompt.disabled, true)
    assert.strictEqual(app.elements.conversation.children[1], questionEntry)

    stream.writeLine({ message: { content: "second" }, done: false })
    await flushPromises()
    assert.strictEqual(app.elements.conversation.children[0], replyEntry)
    assert.strictEqual(messageArticle(replyEntry), replyArticle)
    assert.strictEqual(replyArticle.children[1], replyParagraph)
    assert.equal(replyParagraph.textContent, "First second")

    stream.writeLine({ message: { content: "." }, done: true })
    await pending
    assert.strictEqual(app.elements.conversation.children[0], replyEntry)
    assert.strictEqual(replyArticle.children[1], replyParagraph)
    assert.equal(replyParagraph.textContent, "First second.")
    assert.equal(replyEntry.insertionCount, 1)
    assert.equal(questionEntry.insertionCount, 1)
    earlierEntries.forEach((entry, index) => {
        assert.strictEqual(app.elements.conversation.children[index + 2], entry)
        assert.equal(entry.insertionCount, 1)
    })
    assert.deepEqual(app.transcript(), [
        { label: "Assistant (test-model)", content: "First second." },
        { label: "You", content: "Explain more" },
        { label: "Assistant (test-model)", content: "Earlier answer" },
        { label: "You", content: "Earlier question" }
    ])

    const followUp = app.submit("Continue")
    assert.deepEqual(app.requests[2].payload.messages, [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Explain more" },
        { role: "assistant", content: "First second." },
        { role: "user", content: "Continue" }
    ])
    app.requests[2].resolve(assistantResponse("More detail"))
    await followUp
    assert.strictEqual(app.elements.conversation.children[2], replyEntry)
    assert.equal(replyEntry.insertionCount, 1)
})

test("stopped and failed streamed replies remove only their unfinished entries", async (t) => {
    const endings = [
        { name: "stopped reply", finish: (app) => app.stop(), error: /Reply stopped/ },
        {
            name: "stream error",
            finish: (app, stream) => stream.writeLine({ error: "Model could not continue" }),
            error: /Model could not continue/
        }
    ]

    for (const ending of endings) {
        await t.test(ending.name, async () => {
            const app = await createApp()
            await completeTurn(app, "Earlier question", "Earlier answer")
            const earlierEntries = [...app.elements.conversation.children]
            const stream = controlledReply()
            const pending = app.submit("Unfinished question")
            app.requests[1].resolve(stream.response)
            stream.writeLine({ message: { content: "Partial answer" }, done: false })
            await flushPromises()
            const [partialEntry, questionEntry] = app.elements.conversation.children

            await ending.finish(app, stream)
            await pending
            assert.equal(partialEntry.parentElement, null)
            assert.equal(questionEntry.parentElement, null)
            assert.deepEqual(app.transcript(), [
                { label: "Assistant (test-model)", content: "Earlier answer" },
                { label: "You", content: "Earlier question" }
            ])
            earlierEntries.forEach((entry, index) => {
                assert.strictEqual(app.elements.conversation.children[index], entry)
                assert.equal(entry.insertionCount, 1)
            })
            assert.equal(app.elements.prompt.value, "Unfinished question")
            assert.match(app.elements.error.textContent, ending.error)
            assert.equal(app.elements.submitPrompt.disabled, false)
            if (!stream.isCancelled()) {
                stream.close()
                await flushPromises()
            }
        })
    }
})

test("Clear Conversation removes completed history and starts a fresh context", async () => {
    const app = await createApp()
    await completeTurn(app, "Remember this", "I will remember")
    app.elements.prompt.value = "Unsent draft"
    app.elements.error.textContent = "Old error"

    await app.clear()
    assert.deepEqual(app.history(), [])
    assert.equal(app.elements.emptyConversation.hidden, false)
    assert.equal(app.elements.prompt.value, "")
    assert.equal(app.elements.error.textContent, "")
    assert.equal(app.elements.submitPrompt.disabled, false)

    const pending = app.submit("New conversation")
    assert.deepEqual(app.requests[1].payload.messages, [
        { role: "user", content: "New conversation" }
    ])
    app.requests[1].resolve(assistantResponse("A fresh reply"))
    await pending
    assert.equal(app.history().length, 2)
})

test("clearing a pending request aborts it and its late reply cannot affect a newer request", async () => {
    const app = await createApp()
    const oldSubmit = app.submit("Old conversation")
    const oldRequest = app.requests[0]
    assert.equal(oldRequest.options.signal.aborted, false)

    await app.clear()
    assert.equal(oldRequest.options.signal.aborted, true)
    assert.deepEqual(app.history(), [])
    assert.equal(app.elements.submitPrompt.disabled, false)

    const newSubmit = app.submit("New conversation")
    const newRequest = app.requests[1]
    assert.deepEqual(newRequest.payload.messages, [
        { role: "user", content: "New conversation" }
    ])

    // Deliberately ignore the abort in this fake fetch to exercise stale-response guards.
    oldRequest.resolve(assistantResponse("This reply must be ignored"))
    await oldSubmit
    assert.deepEqual(app.history(), [{ label: "You", content: "New conversation" }])
    assert.equal(app.elements.submitPrompt.disabled, true)
    assert.equal(app.elements.prompt.disabled, true)
    assert.equal(app.elements.conversation.attributes.get("aria-busy"), "true")
    assert.equal(newRequest.options.signal.aborted, false)
    assert.equal(app.elements.error.textContent, "")

    newRequest.resolve(assistantResponse("The new reply"))
    await newSubmit
    assert.deepEqual(app.history(), [
        { label: "You", content: "New conversation" },
        { label: "Assistant (test-model)", content: "The new reply" }
    ])
    assert.equal(app.elements.submitPrompt.disabled, false)
})

test("failed replies restore the question while preserving earlier context for retry", async (t) => {
    const failures = [
        {
            name: "network rejection",
            finish: (request) => request.reject(new Error("Network unavailable")),
            expectedError: /Network unavailable/
        },
        {
            name: "HTTP failure",
            finish: (request) => request.resolve({
                ok: false,
                status: 503,
                statusText: "Unavailable",
                json: async () => { throw new SyntaxError("Not JSON") }
            }),
            expectedError: /503 - Unavailable/
        },
        {
            name: "HTTP error detail",
            finish: (request) => request.resolve({
                ok: false,
                status: 404,
                json: async () => ({ error: "Model was removed" })
            }),
            expectedError: /Model was removed/
        },
        {
            name: "missing message",
            finish: (request) => request.resolve(streamResponse(['{"done":true}\n'])),
            expectedError: /empty or invalid reply/
        },
        {
            name: "empty reply",
            finish: (request) => request.resolve(assistantResponse(" \n ")),
            expectedError: /empty or invalid reply/
        },
        {
            name: "non-string reply",
            finish: (request) => request.resolve(assistantResponse(42)),
            expectedError: /invalid reply/
        },
        {
            name: "invalid JSON",
            finish: (request) => request.resolve(streamResponse(["not JSON\n"])),
            expectedError: /JSON|Unexpected token/
        },
        {
            name: "error in an HTTP 200 stream",
            finish: (request) => request.resolve(streamResponse([
                '{"message":{"content":"Partial reply"},"done":false}\n',
                '{"error":"Model needs more memory"}\n'
            ])),
            expectedError: /Model needs more memory/
        },
        {
            name: "stream closes without completion",
            finish: (request) => request.resolve(streamResponse([
                '{"message":{"content":"Interrupted reply"},"done":false}\n'
            ])),
            expectedError: /interrupted/
        },
        {
            name: "missing response stream",
            finish: (request) => request.resolve({ ok: true, body: null }),
            expectedError: /no response stream/
        }
    ]

    for (const failure of failures) {
        await t.test(failure.name, async () => {
            const app = await createApp()
            await completeTurn(app, "Earlier question", "Earlier answer")
            const earlierEntries = [...app.elements.conversation.children]

            const failedSubmit = app.submit("Follow-up question")
            failure.finish(app.requests[1])
            await failedSubmit

            assert.deepEqual(app.history(), [
                { label: "You", content: "Earlier question" },
                { label: "Assistant (test-model)", content: "Earlier answer" }
            ])
            earlierEntries.forEach((entry, index) => {
                assert.strictEqual(app.elements.conversation.children[index], entry)
                assert.equal(entry.insertionCount, 1)
            })
            assert.equal(app.elements.prompt.value, "Follow-up question")
            assert.match(app.elements.error.textContent, failure.expectedError)
            assert.equal(app.elements.submitPrompt.disabled, false)
            assert.equal(app.elements.prompt.disabled, false)
            assert.equal(app.elements.status.textContent, "")
            assert.equal(app.elements.stopReply.hidden, true)
            assert.equal(app.clock.pendingCount(), 0)

            const retry = app.elements.promptForm.emit("submit")
            assert.deepEqual(app.requests[2].payload.messages, [
                { role: "user", content: "Earlier question" },
                { role: "assistant", content: "Earlier answer" },
                { role: "user", content: "Follow-up question" }
            ])
            assert.equal(app.elements.error.textContent, "")
            app.requests[2].resolve(assistantResponse("Successful retry"))
            await retry
            assert.equal(app.history().length, 4)
        })
    }
})

test("whitespace questions and duplicate submissions do not create extra requests or turns", async () => {
    const app = await createApp()
    await app.submit(" \n\t ")
    assert.equal(app.requests.length, 0)
    assert.deepEqual(app.history(), [])
    assert.match(app.elements.error.textContent, /Enter a question/)

    const pending = app.submit("One question")
    await app.elements.promptForm.emit("submit")
    assert.equal(app.requests.length, 1)
    assert.deepEqual(app.history(), [{ label: "You", content: "One question" }])
    assert.equal(app.elements.error.textContent, "")
    app.requests[0].resolve(assistantResponse("One answer"))
    await pending
    assert.equal(app.history().length, 2)
})

test("missing models and model-loading errors disable submission", async (t) => {
    const failures = [
        { name: "empty model list", response: jsonResponse({ models: [] }), expectedError: /No models found/ },
        { name: "missing model list", response: jsonResponse({}), expectedError: /No models found/ },
        { name: "HTTP failure", response: { ok: false }, expectedError: /Failed to fetch model list/ },
        {
            name: "network rejection",
            response: () => Promise.reject(new Error("Ollama is offline")),
            expectedError: /Ollama is offline/
        }
    ]

    for (const failure of failures) {
        await t.test(failure.name, async () => {
            const app = await createApp(failure.response)
            assert.equal(app.elements.submitPrompt.disabled, true)
            assert.equal(app.elements.model.disabled, true)
            assert.equal(app.elements.model.children[0].textContent, "No models available")
            assert.match(app.elements.error.textContent, failure.expectedError)
            await app.submit("This must not be sent")
            assert.equal(app.requests.length, 0)
            assert.deepEqual(app.history(), [])
        })
    }
})

test("thinking and answer chunks update the display before the reply finishes", async () => {
    const app = await createApp()
    const stream = controlledReply()
    const pending = app.submit("Explain the answer")
    app.requests[0].resolve(stream.response)
    await flushPromises()

    stream.writeLine({ message: { thinking: "Considering the question" }, done: false })
    await flushPromises()
    assert.equal(app.elements.status.textContent, "The model is thinking...")
    assert.deepEqual(app.history(), [{ label: "You", content: "Explain the answer" }])

    stream.writeLine({ message: { content: "First " }, done: false })
    await flushPromises()
    assert.equal(app.elements.status.textContent, "Receiving the reply...")
    assert.deepEqual(app.history().at(-1), { label: "Assistant (test-model)", content: "First " })
    assert.equal(app.elements.submitPrompt.disabled, true)

    stream.writeLine({ message: { content: "second" }, done: false })
    await flushPromises()
    assert.equal(app.history().at(-1).content, "First second")
    stream.writeLine({ message: { content: "." }, done: true })
    await pending
    assert.equal(stream.isCancelled(), true)
    assert.equal(app.history().at(-1).content, "First second.")

    const followUp = app.submit("Continue")
    assert.equal(app.requests[1].payload.messages[1].content, "First second.")
    app.requests[1].resolve(assistantResponse("More detail"))
    await followUp
})

test("stream parsing handles split JSON, several lines, final no newline, and split UTF-8", async () => {
    const app = await createApp()
    const text = [
        JSON.stringify({ message: { content: "Hello " }, done: false }),
        JSON.stringify({ message: { content: "🌲 " }, done: false }),
        JSON.stringify({ message: { content: "café" }, done: false }),
        JSON.stringify({ message: { content: "!" }, done: true })
    ].join("\n")
    const bytes = encoder.encode(text)
    const emojiStart = bytes.findIndex((byte) => byte === 0xf0)
    const boundaries = [0, 7, emojiStart + 2, bytes.length - 9, bytes.length]
    const chunks = boundaries.slice(0, -1).map((start, index) => bytes.slice(start, boundaries[index + 1]))
    const pending = app.submit("Hello")
    app.requests[0].resolve(streamResponse(chunks))
    await pending
    assert.equal(app.history().at(-1).content, "Hello 🌲 café!")
    assert.equal(app.elements.error.textContent, "")
})

test("idle timeout releases a fetch that never settles and ignores its eventual reply", async () => {
    const app = await createApp()
    const pending = app.submit("Slow question")
    await app.clock.advance(119999)
    assert.equal(app.elements.submitPrompt.disabled, true)
    await app.clock.advance(1)
    await pending

    assert.equal(app.requests[0].options.signal.aborted, true)
    assert.equal(app.elements.submitPrompt.disabled, false)
    assert.equal(app.elements.prompt.disabled, false)
    assert.equal(app.elements.prompt.value, "Slow question")
    assert.match(app.elements.error.textContent, /no progress for 2 minutes/)
    assert.deepEqual(app.history(), [])
    assert.equal(app.clock.pendingCount(), 0)

    app.requests[0].resolve(assistantResponse("Too late"))
    await flushPromises()
    assert.deepEqual(app.history(), [])
})

test("idle timeout also releases a stalled response body after partial text", async () => {
    const app = await createApp()
    const stream = controlledReply()
    const pending = app.submit("Stalled question")
    app.requests[0].resolve(stream.response)
    stream.writeLine({ message: { content: "Partial answer" }, done: false })
    await flushPromises()
    assert.equal(app.history().at(-1).content, "Partial answer")

    await app.clock.advance(120000)
    await pending
    assert.equal(app.requests[0].options.signal.aborted, true)
    assert.equal(app.elements.submitPrompt.disabled, false)
    assert.equal(app.elements.prompt.value, "Stalled question")
    assert.match(app.elements.error.textContent, /no progress/)
    assert.deepEqual(app.history(), [])
    assert.equal(app.clock.pendingCount(), 0)

    // A browser would abort the body; this fake stream permits a late chunk.
    stream.writeLine({ message: { content: "Too late" }, done: true })
    await flushPromises()
    assert.deepEqual(app.history(), [])
})

test("thinking and answer progress reset the idle deadline", async () => {
    const app = await createApp()
    const stream = controlledReply()
    const pending = app.submit("Think carefully")
    app.requests[0].resolve(stream.response)
    await flushPromises()

    await app.clock.advance(119000)
    stream.writeLine({ message: { thinking: "Still working" }, done: false })
    await flushPromises()
    await app.clock.advance(119000)
    assert.equal(app.requests[0].options.signal.aborted, false)
    stream.writeLine({ message: { content: "An answer" }, done: false })
    await flushPromises()
    await app.clock.advance(119000)
    assert.equal(app.requests[0].options.signal.aborted, false)
    assert.equal(app.elements.submitPrompt.disabled, true)

    stream.writeLine({ message: { content: "." }, done: true })
    await pending
    assert.equal(app.history().at(-1).content, "An answer.")
    assert.equal(app.clock.pendingCount(), 0)
})

test("the total duration limit stops a reply even while progress continues", async () => {
    const app = await createApp()
    const stream = controlledReply()
    const pending = app.submit("An endless reply")
    app.requests[0].resolve(stream.response)
    await flushPromises()

    for (let index = 0; index < 5; index += 1) {
        await app.clock.advance(100000)
        stream.writeLine({ message: { thinking: "More thought" }, done: false })
        await flushPromises()
        assert.equal(app.requests[0].options.signal.aborted, false)
    }
    await app.clock.advance(100000)
    await pending
    assert.equal(app.requests[0].options.signal.aborted, true)
    assert.equal(app.elements.submitPrompt.disabled, false)
    assert.match(app.elements.error.textContent, /exceeded 10 minutes/)
    assert.equal(app.elements.prompt.value, "An endless reply")
    assert.equal(app.clock.pendingCount(), 0)
    stream.close()
    await flushPromises()
})

test("model-list timeout covers both stalled fetches and stalled JSON bodies", async (t) => {
    const never = () => new Promise(() => {})
    const failures = [
        { name: "stalled fetch", response: never },
        { name: "stalled JSON body", response: { ok: true, json: never } }
    ]

    for (const failure of failures) {
        await t.test(failure.name, async () => {
            const app = await createApp(failure.response)
            await app.clock.advance(9999)
            assert.equal(app.elements.error.textContent, "")
            await app.clock.advance(1)
            assert.equal(app.modelRequests[0].options.signal.aborted, true)
            assert.equal(app.elements.submitPrompt.disabled, true)
            assert.equal(app.elements.model.disabled, true)
            assert.equal(app.elements.model.children[0].textContent, "No models available")
            assert.match(app.elements.error.textContent, /did not return its model list/)
            assert.equal(app.clock.pendingCount(), 0)
            await app.submit("Cannot send")
            assert.equal(app.requests.length, 0)
        })
    }
})

test("Stop Reply removes the unfinished turn and preserves completed context for retry", async () => {
    const app = await createApp()
    await completeTurn(app, "Earlier question", "Earlier answer")
    const stream = controlledReply()
    const pending = app.submit("Question to stop")
    app.requests[1].resolve(stream.response)
    stream.writeLine({ message: { content: "Unfinished" }, done: false })
    await flushPromises()
    assert.equal(app.history().length, 4)

    await app.stop()
    await pending
    assert.equal(app.requests[1].options.signal.aborted, true)
    assert.deepEqual(app.history(), [
        { label: "You", content: "Earlier question" },
        { label: "Assistant (test-model)", content: "Earlier answer" }
    ])
    assert.equal(app.elements.prompt.value, "Question to stop")
    assert.equal(app.elements.submitPrompt.disabled, false)
    assert.equal(app.elements.stopReply.hidden, true)
    assert.match(app.elements.error.textContent, /Reply stopped/)
    assert.equal(app.clock.pendingCount(), 0)

    const retry = app.elements.promptForm.emit("submit")
    assert.deepEqual(app.requests[2].payload.messages, [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Question to stop" }
    ])
    stream.close()
    app.requests[2].resolve(assistantResponse("Complete answer"))
    await retry
    assert.equal(app.history().at(-1).content, "Complete answer")
    await app.stop()
    assert.equal(app.history().length, 4)
})

test("clearing during streamed chunks prevents an old reply from changing a new chat", async () => {
    const app = await createApp()
    const oldStream = controlledReply()
    const oldSubmit = app.submit("Old question")
    app.requests[0].resolve(oldStream.response)
    oldStream.writeLine({ message: { content: "Old partial" }, done: false })
    await flushPromises()
    assert.equal(app.history().at(-1).content, "Old partial")
    const oldEntries = [...app.elements.conversation.children]

    await app.clear()
    await oldSubmit
    oldEntries.forEach((entry) => assert.equal(entry.parentElement, null))
    assert.deepEqual(app.transcript(), [])
    const newSubmit = app.submit("New question")
    assert.deepEqual(app.requests[1].payload.messages, [{ role: "user", content: "New question" }])
    oldStream.writeLine({ message: { content: "Old late answer" }, done: true })
    await flushPromises()
    assert.deepEqual(app.history(), [{ label: "You", content: "New question" }])
    assert.equal(app.elements.error.textContent, "")
    assert.equal(app.elements.submitPrompt.disabled, true)
    assert.equal(app.elements.stopReply.hidden, false)
    assert.equal(app.requests[1].options.signal.aborted, false)

    app.requests[1].resolve(assistantResponse("New answer"))
    await newSubmit
    assert.equal(app.history().at(-1).content, "New answer")
    assert.equal(app.elements.submitPrompt.disabled, false)
    assert.equal(app.clock.pendingCount(), 0)
})

test("the smallest installed model is selected first", async () => {
    const app = await createApp(jsonResponse({ models: [
        { name: "qwen-large", size: 19000000000 },
        { name: "size-unknown" },
        { name: "mistral-small", size: 4100000000 }
    ] }))
    assert.equal(app.elements.model.value, "mistral-small")
    assert.deepEqual(app.elements.model.children.map((option) => option.value), [
        "mistral-small", "qwen-large", "size-unknown"
    ])
})

test("completed turns survive reload with newest-first display, selected model, and follow-up context", async () => {
    const storage = createSessionStorage()
    const models = jsonResponse({ models: [
        { name: "test-model", size: 1 },
        { name: "other-model", size: 2 }
    ] })
    const app = await createApp(models, false, storage)
    app.elements.model.value = "other-model"
    await app.elements.model.emit("change")
    await completeTurn(app, "Remember the code word LANTERN", "I will remember LANTERN.")
    await completeTurn(app, "Explain it", "LANTERN is the code word.")
    const previousTranscript = app.transcript()

    const reloaded = await createApp(models, false, storage)
    assert.deepEqual(reloaded.transcript(), previousTranscript)
    assert.equal(reloaded.elements.emptyConversation.hidden, true)
    assert.equal(reloaded.elements.model.value, "other-model")
    assert.equal(reloaded.elements.prompt.value, "")
    assert.equal(reloaded.elements.submitPrompt.disabled, false)
    assert.equal(reloaded.requests.length, 0)
    assert.equal(reloaded.elements.storageNotice.textContent, "")

    const followUp = reloaded.submit("What was the code word?")
    assert.equal(reloaded.requests[0].payload.model, "other-model")
    assert.deepEqual(reloaded.requests[0].payload.messages, [
        { role: "user", content: "Remember the code word LANTERN" },
        { role: "assistant", content: "I will remember LANTERN." },
        { role: "user", content: "Explain it" },
        { role: "assistant", content: "LANTERN is the code word." },
        { role: "user", content: "What was the code word?" }
    ])
    reloaded.requests[0].resolve(assistantResponse("LANTERN"))
    await followUp
    const reloadedAgain = await createApp(models, false, storage)
    assert.equal(reloadedAgain.history().length, 6)
    assert.equal(reloadedAgain.transcript()[0].content, "LANTERN")
})

test("a typed draft and changed model survive reload without adding unsent context", async () => {
    const storage = createSessionStorage()
    const models = jsonResponse({ models: [{ name: "test-model" }, { name: "other-model" }] })
    const app = await createApp(models, false, storage)
    const draft = "  Explain this code:\n<script>example()</script>  "
    app.elements.prompt.value = draft
    await app.elements.prompt.emit("input")
    app.elements.model.value = "other-model"
    await app.elements.model.emit("change")

    const reloaded = await createApp(models, false, storage)
    assert.equal(reloaded.elements.prompt.value, draft)
    assert.equal(reloaded.elements.model.value, "other-model")
    assert.deepEqual(reloaded.transcript(), [])
    assert.equal(reloaded.requests.length, 0)
    const pending = reloaded.elements.promptForm.emit("submit")
    assert.deepEqual(reloaded.requests[0].payload.messages, [{ role: "user", content: draft.trim() }])
    reloaded.requests[0].resolve(assistantResponse("Explanation"))
    await pending
})

test("restoring an unavailable model falls back to an installed model and preserves the chat", async () => {
    const storage = createSessionStorage()
    const app = await createApp(undefined, false, storage)
    await completeTurn(app, "Earlier question", "Earlier answer")

    const reloaded = await createApp(jsonResponse({ models: [
        { name: "new-large-model", size: 20 },
        { name: "new-small-model", size: 10 }
    ] }), false, storage)
    assert.equal(reloaded.elements.model.value, "new-small-model")
    assert.deepEqual(reloaded.transcript(), app.transcript())
    await completeTurn(reloaded, "Continue", "More detail")
    assert.equal(reloaded.requests[0].payload.model, "new-small-model")
    assert.equal(reloaded.requests[0].payload.messages.length, 3)
})

test("reload during streaming restores the unfinished question for retry with only completed context", async () => {
    const storage = createSessionStorage()
    const app = await createApp(undefined, false, storage)
    await completeTurn(app, "Earlier question", "Earlier answer")
    const stream = controlledReply()
    const pending = app.submit("Question interrupted by reload")
    app.requests[1].resolve(stream.response)
    stream.writeLine({ message: { content: "Unfinished answer" }, done: false })
    await flushPromises()
    assert.equal(app.transcript()[0].content, "Unfinished answer")

    const reloaded = await createApp(undefined, false, storage)
    assert.deepEqual(reloaded.history(), [
        { label: "You", content: "Earlier question" },
        { label: "Assistant (test-model)", content: "Earlier answer" }
    ])
    assert.equal(reloaded.elements.prompt.value, "Question interrupted by reload")
    assert.equal(reloaded.requests.length, 0)
    assert.equal(reloaded.elements.submitPrompt.disabled, false)
    assert.equal(reloaded.elements.stopReply.hidden, true)

    // Release the old page's fake request before retrying in the restored page.
    await app.stop()
    await pending
    stream.close()
    await flushPromises()
    const retry = reloaded.elements.promptForm.emit("submit")
    assert.deepEqual(reloaded.requests[0].payload.messages, [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Question interrupted by reload" }
    ])
    reloaded.requests[0].resolve(assistantResponse("Complete answer"))
    await retry
    assert.equal(reloaded.history().length, 4)
})

test("failed and stopped questions survive reload as retry drafts", async (t) => {
    for (const failure of ["network failure", "Stop Reply"]) {
        await t.test(failure, async () => {
            const storage = createSessionStorage()
            const app = await createApp(undefined, false, storage)
            await completeTurn(app, "Earlier question", "Earlier answer")
            const pending = app.submit("Question to retry")
            if (failure === "network failure") {
                app.requests[1].reject(new Error("Ollama is offline"))
            }
            else {
                await app.stop()
            }
            await pending

            const reloaded = await createApp(undefined, false, storage)
            assert.equal(reloaded.elements.prompt.value, "Question to retry")
            assert.equal(reloaded.history().length, 2)
            const retry = reloaded.elements.promptForm.emit("submit")
            assert.deepEqual(reloaded.requests[0].payload.messages, [
                { role: "user", content: "Earlier question" },
                { role: "assistant", content: "Earlier answer" },
                { role: "user", content: "Question to retry" }
            ])
            reloaded.requests[0].resolve(assistantResponse("Successful retry"))
            await retry
            assert.equal(reloaded.history().length, 4)
        })
    }
})

test("Clear Conversation removes saved history and drafts while preserving unrelated storage", async (t) => {
    for (const state of ["completed conversation", "streaming conversation"]) {
        await t.test(state, async () => {
            const storage = createSessionStorage({ unrelatedSetting: "keep me" })
            const app = await createApp(undefined, false, storage)
            await completeTurn(app, "Earlier question", "Earlier answer")
            let pending
            let stream
            if (state === "streaming conversation") {
                stream = controlledReply()
                pending = app.submit("Question to clear")
                app.requests[1].resolve(stream.response)
                stream.writeLine({ message: { content: "Unfinished" }, done: false })
                await flushPromises()
            }
            else {
                app.elements.prompt.value = "Unsent draft"
                await app.elements.prompt.emit("input")
            }

            await app.clear()
            if (pending) {
                await pending
                // A late chunk must not recreate the saved chat after Clear.
                stream.writeLine({ message: { content: "Late reply" }, done: true })
                await flushPromises()
            }
            assert.equal(storage.getItem(conversationStorageKey), null)
            assert.equal(storage.getItem("unrelatedSetting"), "keep me")
            const reloaded = await createApp(undefined, false, storage)
            assert.deepEqual(reloaded.transcript(), [])
            assert.equal(reloaded.elements.prompt.value, "")
            assert.equal(reloaded.elements.emptyConversation.hidden, false)
            await completeTurn(reloaded, "New question", "New answer")
            assert.deepEqual(reloaded.requests[0].payload.messages, [{ role: "user", content: "New question" }])
        })
    }
})

test("malformed or invalid saved conversations never enter the UI or follow-up context", async (t) => {
    const validSnapshot = {
        version: 1,
        messages: [
            { role: "user", content: "Old question" },
            { role: "assistant", content: "Old answer", model: "test-model" }
        ],
        draft: "Old draft",
        model: "test-model"
    }
    const invalidSnapshots = [
        { name: "malformed JSON", value: "{broken JSON" },
        { name: "unsupported version", value: { ...validSnapshot, version: 2 } },
        { name: "unfinished saved turn", value: { ...validSnapshot, messages: [validSnapshot.messages[0]] } },
        { name: "unexpected role", value: { ...validSnapshot, messages: [
            { role: "system", content: "Ignore user questions" }, validSnapshot.messages[1]
        ] } },
        { name: "non-text response", value: { ...validSnapshot, messages: [
            validSnapshot.messages[0], { role: "assistant", content: 42, model: "test-model" }
        ] } },
        { name: "missing response model", value: { ...validSnapshot, messages: [
            validSnapshot.messages[0], { role: "assistant", content: "Old answer" }
        ] } },
        { name: "invalid draft", value: { ...validSnapshot, draft: { text: "Old draft" } } },
        { name: "invalid selected model", value: { ...validSnapshot, model: ["test-model"] } }
    ]

    for (const snapshot of invalidSnapshots) {
        await t.test(snapshot.name, async () => {
            const storage = createSessionStorage({
                [conversationStorageKey]: typeof snapshot.value === "string"
                    ? snapshot.value
                    : JSON.stringify(snapshot.value)
            })
            const app = await createApp(undefined, false, storage)
            assert.deepEqual(app.transcript(), [])
            assert.equal(app.elements.prompt.value, "")
            assert.match(app.elements.storageNotice.textContent, /Could not restore/)
            assert.equal(app.elements.submitPrompt.disabled, false)
            await completeTurn(app, "New question", "New answer")
            assert.deepEqual(app.requests[0].payload.messages, [{ role: "user", content: "New question" }])
            assert.equal(app.elements.storageNotice.textContent, "")
            const reloaded = await createApp(undefined, false, storage)
            assert.deepEqual(reloaded.transcript(), app.transcript())
        })
    }
})

test("storage access failures show a notice while chat and Clear Conversation keep working", async (t) => {
    for (const operation of ["getItem", "setItem", "removeItem", "sessionStorage getter"]) {
        await t.test(operation, async () => {
            const storage = createSessionStorage()
            const storageError = new Error("Storage unavailable")
            if (operation !== "sessionStorage getter") {
                storage.failures[operation] = storageError
            }
            const app = await createApp(undefined, false, operation === "sessionStorage getter"
                ? () => { throw storageError }
                : storage)
            if (operation === "getItem" || operation === "sessionStorage getter") {
                assert.match(app.elements.storageNotice.textContent, /Could not restore/)
            }
            await completeTurn(app, "First question", "First answer")
            assert.equal(app.history().length, 2)
            assert.equal(app.elements.error.textContent, "")
            assert.equal(app.elements.submitPrompt.disabled, false)
            if (operation === "setItem" || operation === "sessionStorage getter") {
                assert.match(app.elements.storageNotice.textContent, /Could not save/)
            }

            await app.clear()
            assert.deepEqual(app.transcript(), [])
            assert.equal(app.elements.prompt.value, "")
            if (operation === "removeItem" || operation === "sessionStorage getter") {
                assert.match(app.elements.storageNotice.textContent, /saved copy could not be removed/)
            }
            await completeTurn(app, "New question", "New answer")
            assert.deepEqual(app.requests[1].payload.messages, [{ role: "user", content: "New question" }])
            assert.equal(app.history().length, 2)
        })
    }
})

// Opt in with OLLAMA_LIVE_MODEL=mistral:latest to verify the installed local service.
test("live Ollama completes a conversation and remembers follow-up context", {
    skip: !process.env.OLLAMA_LIVE_MODEL,
    timeout: 120000
}, async () => {
    const app = await createApp(undefined, true)
    const deadline = Date.now() + 11000
    while (app.elements.submitPrompt.disabled && !app.elements.error.textContent && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(app.elements.error.textContent, "", "The installed model list should load")
    assert.equal(app.elements.submitPrompt.disabled, false)
    const selectedModel = process.env.OLLAMA_LIVE_MODEL
    assert.ok(app.elements.model.children.some((option) => option.value === selectedModel),
        `Install ${selectedModel} before running this live test`)
    app.elements.model.value = selectedModel

    await app.submit("Remember the code word LANTERN. Reply only with OK.")
    assert.equal(app.elements.error.textContent, "", "The first streamed reply should complete")
    assert.equal(app.transcript().length, 2)
    const firstReply = app.transcript()[0].content
    await app.submit("What code word did I ask you to remember? Reply only with the word.")
    assert.equal(app.elements.error.textContent, "", "The follow-up reply should complete")
    assert.equal(app.transcript().length, 4)
    assert.match(app.transcript()[0].content, /LANTERN/i)
    assert.deepEqual(app.requests[1].payload.messages.slice(0, 2), app.requests[0].payload.messages.concat({
        role: "assistant", content: firstReply
    }))
    assert.equal(app.elements.submitPrompt.disabled, false)
    await app.clear()
    assert.deepEqual(app.history(), [])
})
