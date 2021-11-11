<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/home.svelte";
	import Field from "./routes/field.svelte";
	export let url = "";
</script>

<div>
	<Router {url}>
		<nav>
			<Link to="/">Home</Link>
			<Link to="field">Question</Link>
		</nav>
		<div>
			<Route path="/">
				<Home />
			</Route>
			<Route path="field" component={Field} />
		</div>
	</Router>
</div>
