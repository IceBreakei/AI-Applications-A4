const OLLAMA_API_URL = "http://localhost:11434/api/chat"
const OLLAMA_TAG = "http://localhost:11434/api/tags"
const CONVERSATION_STORAGE_KEY = "followAlongOllama.conversation"

// Large local models can take time to load. Stop requests that make no progress.
const MODEL_LIST_TIMEOUT_MS = 10000
const REPLY_IDLE_TIMEOUT_MS = 120000
const REPLY_MAX_DURATION_MS = 600000

// Keep references to the form controls and conversation display in one place.
const promptForm = document.getElementById("promptForm")
const promptInput = document.getElementById("prompt")
const modelSelect = document.getElementById("model")
const submitButton = document.getElementById("submitPrompt")
const clearButton = document.getElementById("clearConversation")
const stopButton = document.getElementById("stopReply")
const errorElem = document.getElementById("error")
const statusElem = document.getElementById("status")
const storageNoticeElem = document.getElementById("storageNotice")
const conversationElem = document.getElementById("conversation")
const emptyConversationElem = document.getElementById("emptyConversation")

// Keep API context chronological and restore completed turns after a tab reload.
const conversationHistory = []
const messageElements = new Map()
let modelsAvailable = false
let activeRequest = null
let pendingReply = null
let restoredModel = null

function saveConversation() {
    // A question awaiting a reply is saved as a draft, not an unfinished API turn.
    const lastMessage = conversationHistory.at(-1)
    const hasPendingQuestion = lastMessage?.role === "user"
    const snapshot = {
        version: 1,
        messages: hasPendingQuestion ? conversationHistory.slice(0, -1) : conversationHistory,
        draft: hasPendingQuestion ? lastMessage.content : promptInput.value,
        model: modelsAvailable ? modelSelect.value : restoredModel
    }

    try {
        // sessionStorage survives reloads in this tab without saving to the server.
        sessionStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(snapshot))
        storageNoticeElem.textContent = ""
    }
    catch (error) {
        console.error("Error saving conversation", error)
        storageNoticeElem.textContent = "Could not save the conversation. Reloading may lose recent messages."
    }
}

function restoreConversation() {
    try {
        const savedConversation = sessionStorage.getItem(CONVERSATION_STORAGE_KEY)
        if (!savedConversation) {
            return
        }

        const snapshot = JSON.parse(savedConversation)
        // Restore only complete user/assistant pairs with valid text and model labels.
        const validMessages = Array.isArray(snapshot?.messages)
            && snapshot.messages.length % 2 === 0
            && snapshot.messages.every((message, index) =>
                message?.role === (index % 2 === 0 ? "user" : "assistant")
                && typeof message.content === "string"
                && message.content.trim().length > 0
                && (message.role === "user" || typeof message.model === "string")
            )
        if (snapshot?.version !== 1 || !validMessages || typeof snapshot.draft !== "string"
            || (snapshot.model !== null && typeof snapshot.model !== "string")) {
            throw new Error("The saved conversation is invalid.")
        }

        snapshot.messages.forEach((message) => {
            const restoredMessage = { role: message.role, content: message.content }
            if (message.role === "assistant") {
                restoredMessage.model = message.model
            }
            conversationHistory.push(restoredMessage)
        })
        promptInput.value = snapshot.draft
        restoredModel = snapshot.model
    }
    catch (error) {
        // Unavailable or malformed storage should not prevent a new conversation.
        console.error("Error restoring conversation", error)
        storageNoticeElem.textContent = "Could not restore the saved conversation. You can still start a new chat."
    }
}

function clearSavedConversation() {
    try {
        // Remove only this app's saved chat, leaving other session storage untouched.
        sessionStorage.removeItem(CONVERSATION_STORAGE_KEY)
        storageNoticeElem.textContent = ""
    }
    catch (error) {
        console.error("Error clearing saved conversation", error)
        storageNoticeElem.textContent = "The visible conversation was cleared, but its saved copy could not be removed."
    }
}

function watchRequest(request, timeoutMs, timeoutMessage) {
    let timeoutId
    let rejectOnAbort

    // Race cancellation against the network so even a stalled request releases the UI.
    const cancelled = new Promise((resolve, reject) => {
        rejectOnAbort = () => reject(request.signal.reason)
        request.signal.addEventListener("abort", rejectOnAbort, { once: true })
    })

    function reset() {
        clearTimeout(timeoutId)
        timeoutId = setTimeout(() => request.abort(new Error(timeoutMessage)), timeoutMs)
    }

    reset()
    return {
        cancelled,
        reset,
        stop() {
            clearTimeout(timeoutId)
            request.signal.removeEventListener("abort", rejectOnAbort)
        }
    }
}

function updateFormState() {
    // Allow one request at a time, while keeping Clear Conversation available.
    const isLoading = activeRequest !== null
    submitButton.disabled = isLoading || !modelsAvailable
    modelSelect.disabled = isLoading || !modelsAvailable
    promptInput.disabled = isLoading
    stopButton.hidden = !isLoading
    submitButton.textContent = isLoading ? "Generating..." : "Submit"
    statusElem.textContent = isLoading ? "Waiting for Ollama to reply. The model may need time to load." : ""
    conversationElem.setAttribute("aria-busy", String(isLoading))
}

function getModelColor(modelName) {
    // Hash the full model name so new models get stable colors without a manual list.
    let hash = 2166136261
    for (const character of modelName) {
        hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0
    }

    // Vary the hue and shade while keeping every background dark for white text.
    const hue = hash % 360
    const saturation = 40 + ((hash >>> 9) % 26)
    const lightness = 18 + ((hash >>> 17) % 9)
    return `hsl(${hue} ${saturation}% ${lightness}%)`
}

function createMessageElement(message) {
    const entryElem = document.createElement("div")
    const entryContentElem = document.createElement("div")
    const messageElem = document.createElement("article")
    const labelElem = document.createElement("strong")
    const contentElem = document.createElement("p")

    // The outer wrappers expand from zero height, pushing older bubbles down.
    entryElem.className = "message-entry"
    entryContentElem.className = "message-entry-content"
    messageElem.className = `message message-${message.role}`
    if (message.role === "assistant") {
        // Use this message's model so earlier and restored replies keep their color.
        messageElem.style.setProperty("--model-background", getModelColor(message.model))
    }
    labelElem.textContent = message.role === "user" ? "You" : `Assistant (${message.model})`
    messageElem.append(labelElem, contentElem)
    entryContentElem.append(messageElem)
    entryElem.append(entryContentElem)

    return { element: entryElem, contentElem }
}

function renderConversation() {
    emptyConversationElem.hidden = conversationHistory.length > 0
    // Partial replies are visible but only completed replies become follow-up context.
    const visibleMessages = pendingReply === null
        ? conversationHistory
        : [...conversationHistory, pendingReply]
    const currentMessages = new Set(visibleMessages)

    // Remove cleared or failed turns while preserving the remaining bubble elements.
    messageElements.forEach((entry, message) => {
        if (!currentMessages.has(message)) {
            entry.element.remove()
            messageElements.delete(message)
        }
    })

    visibleMessages.forEach((message) => {
        let entry = messageElements.get(message)
        if (!entry) {
            entry = createMessageElement(message)
            messageElements.set(message, entry)

            // The UI is newest first; conversationHistory stays chronological for Ollama.
            conversationElem.prepend(entry.element)
        }

        // Update text in place so streaming never recreates or reanimates a bubble.
        // textContent also displays HTML and code snippets safely as literal text.
        if (entry.contentElem.textContent !== message.content) {
            entry.contentElem.textContent = message.content
        }
    })
}

async function loadOllamaModels() {
    const request = new AbortController()
    const watcher = watchRequest(request, MODEL_LIST_TIMEOUT_MS,
        "Ollama did not return its model list. Check that Ollama is running, then refresh the page.")

    try {
        // Fetch installed models before enabling the Submit button.
        const loadModels = async () => {
            const response = await fetch(OLLAMA_TAG, { signal: request.signal })
            if (!response.ok) {
                throw new Error("Failed to fetch model list")
            }
            return response.json()
        }
        const data = await Promise.race([loadModels(), watcher.cancelled])
        if (!Array.isArray(data.models) || data.models.length === 0) {
            throw new Error("No models found. Install an Ollama model to start chatting.")
        }

        // Start with the smallest installed model to reduce local loading delays.
        const models = [...data.models].sort((first, second) =>
            (first.size ?? Infinity) - (second.size ?? Infinity)
        )
        const options = models.map((model) => {
            const option = document.createElement("option")
            option.value = model.name
            option.textContent = model.name
            return option
        })
        modelSelect.replaceChildren(...options)
        modelsAvailable = true
        if (models.some((model) => model.name === restoredModel)) {
            modelSelect.value = restoredModel
        }
    }
    catch (error) {
        console.error("Error loading models", error)
        errorElem.textContent = error.message
        modelSelect.replaceChildren()
        const option = document.createElement("option")
        option.textContent = "No models available"
        option.disabled = true
        modelSelect.append(option)
    }
    finally {
        watcher.stop()
        updateFormState()
    }
}

async function readOllamaReply(payload, request, onProgress) {
    const response = await fetch(OLLAMA_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: request.signal
    })
    if (request.signal.aborted) {
        response.body?.cancel().catch(() => {})
        throw request.signal.reason
    }
    if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || `Error: ${response.status} - ${response.statusText}`)
    }
    if (!response.body) {
        throw new Error("Ollama returned no response stream.")
    }

    onProgress("", false)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let reply = ""
    let finished = false

    function readLine(line) {
        if (!line.trim()) {
            return
        }
        const data = JSON.parse(line)
        if (data.error) {
            throw new Error(data.error)
        }
        if (data.message?.content !== undefined && typeof data.message.content !== "string") {
            throw new Error("The model returned an invalid reply. Please try again.")
        }

        reply += data.message?.content || ""
        onProgress(reply, Boolean(data.message?.thinking))
        finished = data.done === true
    }

    try {
        // Ollama sends one JSON object per line. Network chunks may split any line.
        while (!finished) {
            const { value, done } = await reader.read()
            if (request.signal.aborted) {
                throw request.signal.reason
            }

            buffer += decoder.decode(value, { stream: !done })
            const lines = buffer.split("\n")
            buffer = lines.pop()
            for (const line of lines) {
                readLine(line)
                if (finished) {
                    break
                }
            }

            if (done && !finished) {
                // Accept a final JSON line without a newline, but require completion.
                readLine(buffer)
                if (!finished) {
                    throw new Error("Ollama's reply was interrupted. Please try again.")
                }
            }
        }

        if (!reply.trim()) {
            throw new Error("The model returned an empty or invalid reply. Please try again.")
        }
        return reply
    }
    finally {
        // Release the stream on completion, cancellation, or an invalid response.
        reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

async function getOllamaResponse(event) {
    event.preventDefault()
    if (activeRequest !== null || !modelsAvailable) {
        return
    }

    const userPrompt = promptInput.value.trim()
    if (!userPrompt) {
        errorElem.textContent = "Enter a question before submitting."
        return
    }

    const selectedModel = modelSelect.value
    const request = new AbortController()
    activeRequest = request
    errorElem.textContent = ""

    // Show the new question immediately, then send every previous turn as context.
    conversationHistory.push({ role: "user", content: userPrompt })
    renderConversation()
    promptInput.value = ""
    updateFormState()
    saveConversation()

    const payload = {
        model: selectedModel,
        messages: conversationHistory.map((message) => ({
            role: message.role,
            content: message.content
        })),
        stream: true
    }

    const watcher = watchRequest(request, REPLY_IDLE_TIMEOUT_MS,
        "Ollama made no progress for 2 minutes. Try again or select a smaller model.")
    const maximumTimeoutId = setTimeout(() => request.abort(new Error(
        "The reply exceeded 10 minutes. Try a shorter question or a smaller model."
    )), REPLY_MAX_DURATION_MS)

    try {
        const readReply = readOllamaReply(payload, request, (reply, isThinking) => {
            if (activeRequest !== request) {
                return
            }

            // Thinking chunks count as progress even before answer text is available.
            watcher.reset()
            statusElem.textContent = isThinking && !reply
                ? "The model is thinking..."
                : "Receiving the reply..."
            if (reply) {
                if (pendingReply === null) {
                    pendingReply = { role: "assistant", content: "", model: selectedModel }
                }
                pendingReply.content = reply
                renderConversation()
            }
        })
        const reply = await Promise.race([readReply, watcher.cancelled])

        // Ignore a late reply if Clear Conversation has cancelled this request.
        if (activeRequest !== request) {
            return
        }
        // Commit the same message object so its visible bubble stays in place.
        const assistantMessage = pendingReply ?? {
            role: "assistant",
            content: "",
            model: selectedModel
        }
        assistantMessage.content = reply
        conversationHistory.push(assistantMessage)
        pendingReply = null
        renderConversation()
        saveConversation()
    }
    catch (error) {
        if (activeRequest !== request) {
            return
        }

        // Restore a failed question for retry without duplicating it in the context.
        request.abort(error)
        conversationHistory.pop()
        pendingReply = null
        renderConversation()
        promptInput.value = userPrompt
        errorElem.textContent = `Could not get a reply. ${error.message}`
        console.error("Error communicating with Ollama", error)
        saveConversation()
    }
    finally {
        watcher.stop()
        clearTimeout(maximumTimeoutId)
        // An old request must never reset the controls of a newer conversation.
        if (activeRequest === request) {
            activeRequest = null
            updateFormState()
            promptInput.focus()
        }
    }
}

function clearConversation() {
    // Cancel any pending reply and remove all messages from the UI and API context.
    if (activeRequest !== null) {
        activeRequest.abort()
        activeRequest = null
    }
    conversationHistory.length = 0
    pendingReply = null
    promptInput.value = ""
    errorElem.textContent = ""
    restoredModel = null
    clearSavedConversation()
    renderConversation()
    updateFormState()
    promptInput.focus()
}

// Connect the controls and prepare the initial empty conversation.
promptForm.addEventListener("submit", getOllamaResponse)
promptInput.addEventListener("input", saveConversation)
modelSelect.addEventListener("change", saveConversation)
clearButton.addEventListener("click", clearConversation)
stopButton.addEventListener("click", () => {
    // Stop just the current reply, preserving the completed conversation for retry.
    if (activeRequest !== null) {
        activeRequest.abort(new Error("Reply stopped. Your question is ready to retry."))
    }
})
restoreConversation()
renderConversation()
updateFormState()
loadOllamaModels()
