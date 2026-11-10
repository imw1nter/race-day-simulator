"""Start Race Day Simulator and open it in the browser."""
import threading
import webbrowser

import uvicorn

URL = "http://127.0.0.1:8000/"

if __name__ == "__main__":
    # Open the browser shortly after the server starts
    threading.Timer(1.5, lambda: webbrowser.open(URL)).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000)