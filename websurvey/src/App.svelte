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
			<Link to="/survey/:ref">Question</Link>
		</nav>
		<Route path="/">
			<Home />
		</Route>
		<Route path="/survey/:ref" let:params>
			<Form ref={`${params.ref}`} />
		</Route>
	</Router>
</main>
