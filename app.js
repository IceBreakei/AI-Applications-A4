const OLLAMA_API_URL = "http://localhost:11434/api/generate"
const OLLAMA_TAG = "http://localhost:11434/api/tags"

const modelSelect = document.getElementById("model")
const errorElem = document.getElementById("error")
const awnser = document.getElementById("awnser")

async function loadOllamaModels() {
    try {
        //call ollama and fetch models
        const response = await fetch(OLLAMA_TAG)
        if (!response.ok) {
            errorElem.innerHTML = "Failed to fetch model list"
            throw new Error("Failed to fetch model list")
        }
        const data = await response.json()
        //make sure at least 1 moddel like this
        if (data.models && data.models.length > 0) {
            //map every model and create something new from me
            const optionsHtml = data.models.map((model)=>
                `<option value=${model.name}>${model.name}</option>`
            ).join("")
            modelSelect.innerHTML = optionsHtml
        }
        else {
            modelSelect.innerHTML = `<option disabled>No Model Found</option>`
        }
    }
    catch (error) {
        console.error("Error loading models", error)
        errorElem.innerHTML = error.message;
        modelSelect.innerHTML = `<option disabled>${error.message}</option>`
    }
}

loadOllamaModels()

async function getOllamaResponse(event) {
    event.preventDefault()
    //get user prompt
    const userPrompt = document.getElementById("prompt").value
    const payload = {
        model : modelSelect.value,
        prompt : userPrompt,
        stream : false
    }

    try { 
        const response = await fetch(OLLAMA_API_URL, {
            method : "POST",
            headers: {"Content-Type": "application/json"},
            body : JSON.stringify(payload)
        })
        if (!response.ok){
            throw new Error(`Error:${response.status} - ${response.statusText}`)
        }
        const data = await response.json()

        console.log (modelSelect.value + "OUTPUT", data)

        awnser.innerHTML = `<p>${modelSelect.value} output:</p>${data.response}`
    }
    catch (error){
        console.error("ERROR communication with Ollama". error)
    }
}

document.getElementById("promptForm").addEventListener("submit", getOllamaResponse)