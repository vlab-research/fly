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

### Testing locally

Fly is made up of multiple services, where each service is responsible for a specific _scope of work_.

For convenience, we have created tools to make it easy to add features and bug fixes to services, while maintaining the expected behaviors of previous features. We took inspiration from test-driven-development to enable developers to write new business logic while testing continuously in a hot-reload fashion. This closed feedback loop allows early detection of potential problems.

Because services are written using two programming languages (`javascript` and `go`), the test suite naturally behaves differently for each of them (we use `mocha` for `javascript` and `testing` for `go`), but they are _initialized_ in the same way.

For services written in `javascript` or `go`, you can start the local test suite by executing in your terminal:

```
./test.sh {NAME_OF_SERVICE}
```

where `{NAME_OF_SERVICE}` corresponds to the name of the service (the name of the directory). For example, if you want to run the `scribble` test suite, you can type in your terminal:

```
./test.sh scribble
```

The `scribble` service is written in `go`, but you can use any service name, even those written in `javascript`.

Once it's running, you can edit the service code and the test suite will run all the tests for that service every time you save your changes. _How cool!_

#### Running a single test

Sometimes, it's convinient to run only one test at the time. 

For tests executed by `mocha`, you can add `.only()` to the test. For more information on `only()`, visit https://mochajs.org/#exclusive-tests.

For tests written in `go`, you can add the name of the test that you want to run exclusively, to the command that _initializes_ the test suite. For example, if the name of the test is `TestCreateUserReturnsSuccess`, the command you will execute in your terminal will look like this:

```
./test.sh scribble TestCreateUserReturnsSuccess
```

### Printing the DB schema

For convenience, we include a script that prints the DB schema.

To print the DB schema:
1. execute `./test.sh {NAME_OF_SERVICE}`. Choose a service that uses the DB.
2. once the service is ready, open a new terminal window
3. on the new window, execute `./dbschema.sh`

You should now see the table schema printed on your screen.

### Testing inside Kubernetes

Make sure you have KIND installed.

Then run:

``` shell
cd devops
./dev-cluster.sh
```

