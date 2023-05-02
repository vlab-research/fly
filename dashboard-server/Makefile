

build:
	@docker build -t localhost:5000/dashboard:registry .
	@docker push localhost:5000/dashboard:registry
	@kubectl delete pod -l app.kubernetes.io/name=dashboard
