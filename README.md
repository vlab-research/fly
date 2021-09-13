# Fly

Fly is a survey platform designed for longitudinal studies in poor network conditions and low powered devices.

## Deployment

Something like this:

``` shell
cd devops
./setup-kube.sh
helm install fly vlab -f values/production.yaml
```

## Development

Make sure you have KIND installed.

Then run:

``` shell
cd devops
./dev-cluster.sh
```

rsync -a $PWD/ 34.121.155.40:/home/carlos/test4


# Print struct

fmt.Printf("%+v", obj)

https://github.com/vlab-research/fly/commit/b0e949944028edab871b895da10da49f02fb900e#diff-87db2986ad943383ea20fca92a957e262392aa08837faf62762e6632717c806bL30


int32(32)


-- reset db using diff container
-- bake base image for dev
-- update test chart and prod chart
-- truncate tables
