# FLY Deployment


## Updateing  Helm Charts

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

