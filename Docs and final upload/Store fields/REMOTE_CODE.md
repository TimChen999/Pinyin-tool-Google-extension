# Remote Code

Select: Yes, I am using remote code

## Justification

The extension uses Tesseract.js for OCR text extraction from images. At runtime, Tesseract.js downloads its WASM core engine and Chinese (Simplified) trained language data from cdn.jsdelivr.net. These files are required to perform on-device text recognition and are loaded only when the user explicitly triggers the OCR feature via the popup. No other remote code is used — all other JavaScript is bundled in the extension package, and LLM provider calls (OpenAI, Gemini, Ollama) are standard HTTP API data requests, not remote code execution.
