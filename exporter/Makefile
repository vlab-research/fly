

build:
	@docker build -t localhost:5000/exporter:registry .
	@docker push localhost:5000/exporter:registry
	@kubectl delete pod -l app.kubernetes.io/name=exporter-chart
