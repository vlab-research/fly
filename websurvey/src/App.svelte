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
		</nav>
		<Route path="/:ref" component={Form} />
	</Router>

</main>
