<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";
	export let url = "";
</script>

<main>
	<Router {url}>
		<nav>
			<Link to="/">Home</Link>
			<Link to="/survey/:id">Question</Link>
		</nav>
		<Route path="/">
			<Home />
		</Route>
		<Route path="/survey/:id" let:params>
			<Form id={params.id} />
		</Route>
	</Router>
</main>
