<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/home.svelte";
	import Form from "./routes/form.svelte";
	export let url = "";
</script>

<main>
	<Router {url}>
		<nav>
			<Link to="/">Home</Link>
			<Link to="/:id">Question</Link>
		</nav>
		<Route path="/">
			<Home />
		</Route>
		<Route path="/:id" component={Form} />
	</Router>
</main>
