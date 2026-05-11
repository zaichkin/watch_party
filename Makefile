start-server:
	python3 server.py &

start-tuna: start-server
	tuna http 8000

start-ngrok: start-server
	ngrok http 8000 --request-header-add "ngrok-skip-browser-warning: true"