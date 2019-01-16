# Using Helm charts

The [Helm](https://helm.sh/) package manager is one of the most commonly used tools for managing Kubernetes manifests. Garden supports using your own Helm charts, alongside your container modules, via the `kubernetes` and `local-kubernetes` providers. This guide shows you how to configure and use 3rd-party (or otherwise external) Helm charts, as well as your own charts in your Garden project. We also go through how to set up tests, tasks and hot-reloading for your charts.

In this guide we'll be using the [vote-helm](https://github.com/garden-io/garden/tree/hot-as-helm/examples/vote-helm) project. If you prefer to just check out a complete example, the project itself is also a good resource.

You may also want to check out the full [helm module reference](../reference/config.md#helm).

## Basics

First off, a couple of things to note on how the Helm support is implemented, with respect to Garden primitives:

1) One `helm` _module_ maps to a single Garden _service_ (not to be confused with Kubernetes Service resources), with the same name as the module.
2) Because a Helm chart only contains manifests and not actual code (i.e. your containers/images), you'll often need to make two Garden modules for a single deployed service, e.g. one `container` module for your image, and then the `helm` module that references it.

## Referencing external charts

Using external charts, where the chart sources are not located in your own project, can be quite straightforward. At a
minimum, you just need to point to the chart, and perhaps provide some values as inputs. Here is the `redis` module from
our example project, for example:

```yaml
module:
  description: Redis service for queueing votes before they are aggregated
  type: helm
  name: redis
  chart: stable/redis
  values:
    usePassword: false
```

For a simple setup, this may be all you need for a chart to be deployed with the rest of your stack. You can also list `redis` as a dependency of one of your other services, and this Helm chart is automatically deployed ahead of it, in dependency order.

You may also add a `repo` field, to reference a specific chart repository. This may be useful if you run your own chart repository for your organization, or are referencing a module that isn't contained in the default Helm repo.

## Local charts

Instead of fetching the chart sources from another repository, you'll often want to include your chart sources in your Garden project. To do this, you can simply add a `garden.yml` in your chart directory (next to your `Chart.yaml`) and start by giving it a name:

```yaml
module:
  description: Helm chart for my module
  type: helm
  name: my-module
```

You can also use Garden's external repository support, to reference chart sources in another repo:

```yaml
module:
  description: Helm chart for my module
  type: helm
  name: my-module
  repositoryUrl: https://github.com/my-org/my-helm-chart#v0.1
```

## Tasks and tests

You may also want to define _tests_ and/or _tasks_ that execute in one of the containers defined in the chart. An example of this is how we define tasks in the `vote-helm/postgres` module:

```yaml
module:
  description: Postgres database for storing voting results
  type: helm
  name: postgres
  chart: stable/postgresql
  version: 3.9.2    # the chart version to fetch
  serviceResource:
    kind: StatefulSet
    name: postgres
  tasks:
    - name: db-init
      args: [ psql, -w, -U, postgres, ..., -c, "'CREATE TABLE IF NOT EXISTS votes ..." ]
      env:
        PGPASSWORD: postgres
      dependencies:
        - postgres
    - name: db-clear
      args: [ psql, -w, -U, postgres, ..., -c, "'TRUNCATE votes'" ]
      env:
        PGPASSWORD: postgres
      dependencies:
        - postgres
```

Note first the `serviceResource` field. This tells Garden which Kubernetes _Deployment_, _DaemonSet_ or _StatefulSet_ to regard as the primary resource of the chart. In this case, it is simply the `postgres` application itself. When running the `db-init` and `db-clear` tasks, Garden will find the appropriate container spec in the chart based on the `serviceResource` spec, and then execute that container with the task's `args` and (optionally) the specified `env` variables.

The same applies to any _tests_ that you specify. Take for example the `vote` module:

```yaml
module:
  description: Helm chart for the voting UI
  type: helm
  name: vote
  serviceResource:
    kind: Deployment
  ...
  tests:
    - name: integ
      args: [npm, run, test:integ]
      dependencies:
        - api
```

Instead of the top-level `serviceResource` you can also add a `resource` field with the same schema to any individual task or test specification. This can be useful if you have different containers in the chart that you want to use for different scenarios.

## Linking container modules and Helm modules

When your project also contains one or more `container` modules that build the images used by a `helm` module, you want to make sure the `container`s are built ahead of deploying the Helm chart, and that the correct image tag is used when deploying. The `vote-helm/worker` module and the corresponding `worker-image` module provide a simple example:

```yaml
module:
  description: Helm chart for the worker container
  type: helm
  name: worker
  ...
  build:
    dependencies: [worker-image]
  values:
    image:
      tag: ${modules.worker-image.version}
```

```yaml
module:
  description: The worker that collects votes and stores results in a postgres table
  type: container
  name: worker-image
```

Here the `worker` module specifies the image as a build dependency, and additionally injects the `worker-image` version into the Helm chart via the `values` field. Note that the shape of the chart's `values.yml` file will dictate how exactly you provide the image version/tag to the chart (this example is based on the default template generated by `helm create`), so be sure to consult the reference for the chart in question.

Notice that this can also work if you have multiple containers in a single chart. You just add them all as build dependencies, and the appropriate reference under `values`.

## Hot reloading

When your project contains the `container` module referenced by a `helm` module, you can even use Garden's [hot-reloading](./hot-reload.md) feature for a Helm chart. Going back to the `vote` module example:

```yaml
module:
  description: Helm chart for the voting UI
  type: helm
  name: vote
  serviceResource:
    kind: Deployment
    containerModule: vote-image       # The name of your container module.
    hotReloadArgs: [npm, run, serve]  # Arguments to override the default arguments in the resource's container.
  ...
```

For hot-reloading to work you must specify `serviceResource.containerModule`, so that Garden knows which module contains the sources to use for hot-reloading. You can then optionally add `serviceResource.hotReloadArgs` to, for example, start the container with automatic reloading or in development mode.

For the above example, you could then run `garden deploy -w --hot-reload=vote` or `garden dev --hot-reload=vote` to start the `vote` service in hot-reloading mode. When you then change the sources in the _vote-image_ module, Garden syncs the changes to the running container from the Helm chart.

## Re-using charts

Often you'll want to re-use the same Helm charts for multiple modules. For example, you might have a generic template
for all your backend services that configures auto-scaling, secrets/keys, sidecars, routing and so forth, and you don't
want to repeat those configurations all over the place.

You can achieve this by using the `base` field on the `helm` module type. Staying with our `vote-helm` example project,
let's look at the `base-chart` and `api` modules:

```yaml
# base-chart
module:
  description: Base Helm chart for services
  type: helm
  name: base-chart
  serviceResource:
    kind: Deployment
  skipDeploy: true
```

```yaml
# api
module:
  description: The API backend for the voting UI
  type: helm
  name: api
  base: base-chart
  serviceResource:
    containerModule: api-image
  dependencies:
    - redis
  values:
    name: api
    image:
      repository: api-image
      tag: ${modules.api-image.version}
    ingress:
      enabled: true
      paths: [/]
      hosts: [api.local.app.garden]
```

Here, the `base-chart` module contains the actual Helm chart and templates. Note the `skipDeploy` flag, which we set
because the module should only be used as a base chart in this case.

The `api` module only contains the `garden.yml` file, but configures the base chart using the `values` field, and also
sets its own dependencies (those are not inherited) and specifies its `serviceResource.containerModule`.

In our base chart, we make certain values like `name`, `image.repository` and `image.tag` required (using the
[required](https://github.com/helm/helm/blob/master/docs/charts_tips_and_tricks.md#using-the-required-function)
helper function) in order to enforce correct usage. We recommend enforcing constraints like that, so that mistakes
can be caught quickly.

The `result` module also uses the same base chart, but sets different values and metadata:

```yaml
module:
  description: Helm chart for the results UI
  type: helm
  name: result
  base: base-chart
  serviceResource:
    containerModule: result-image
    hotReloadArgs: [nodemon, server.js]
  dependencies:
    - db-init
  values:
    name: result
    image:
      repository: result-image
      tag: ${modules.result-image.version}
    ingress:
      enabled: true
      paths: [/]
      hosts: [result.local.app.garden]
  tests:
    - name: integ
      args: [echo, ok]
      dependencies:
        - db-init
```

This pattern can be quite powerful, and can be used to share common templates across your organization. You could
even have an organization-wide repository of base charts for different purposes, and link it in your project config
with something like this:

```yaml
project:
  sources:
    - name: base-charts
      repositoryUrl: https://github.com/my-org/helm-base-charts.git#v0.1.0
  ...
```

The base chart can also be any `helm` module (not just "base" charts specifically made for that purpose), so you have
a lot of flexibility in how you organize your charts.