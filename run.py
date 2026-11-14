"""Start Race Day Simulator and open it in the browser."""
import threading
import webbrowser

URL = "http://127.0.0.1:8000/"

if __name__ == "__main__":
    print("Starting Race Day Simulator... the first start can take up to 30 seconds.")
    import uvicorn  # imported after the message, since loading the libraries is the slow part

    # Open the browser shortly after the server starts
    threading.Timer(3, lambda: webbrowser.open(URL)).start()
    print(f"Opening {URL} (press Ctrl+C to stop)")
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000)