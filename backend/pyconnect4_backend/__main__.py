"""Run with: python -m pyconnect4_backend"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("pyconnect4_backend.app:app", host="127.0.0.1", port=8000, reload=False)
