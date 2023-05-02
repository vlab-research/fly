# FLY Deployment

## Setting up dev environment

You will need to install [kind][1] in order to run the full development setup


Once installed you can simply run:

```bash
make dev
```
> This takes quite a while, you can watch the pods starting by running `kubectl get pods` in another terminal


Once this is done you can run the integration tests by running:

```bash
make dev-integration-tests
```

This will create a test runner which you can follow by running

```bash
kubectl logs -f -l app=testrunner --tail -1
```

## Running Integration Tests
**NOTE:** this is a resource intensive process that takes a fair amount of time
please be patient

In order to run integration tests you will need to have access to a kubernetes
cluster. All the dependencies will be created in a single namespace

```bash
make integration-tests
```

## Updating  Helm Charts

We use the OCI registry to configure helm charts therefore you should do the
following to update a helm chart

1. You ill need to configure authentication for the OCI registry

```bash

gcloud auth login

gcloud auth configure-docker
```
> NOTE the following commands will only work if you have access to the OCI
registry

2. Go to the application directory you want to update the chart for

```bash
cd ../${application}
```

3. Update the chart there, remember to update the version in the `Chart.yaml` file

4. Build the chart with the following command (requires Helm 3)

```bash
helm package chart
```

5. push the built chart to the repository

```bash
helm push ${application}-${version}.tgz  oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts
```

**NOTE:** Tags are immutable, you will not be able to overwrite a tag that is
already created in the OCI registry

6. Update the chart version in the main charts [Chart.yaml](./vlab/Chart.yaml)

7. Update the main charts dependencies

```bash
cd vlab/

helm dependency update
```

[1]: https://kind.sigs.k8s.io/docs/user/quick-start/
