<script>
	import { Router, Route } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";
	// import Thankyou from "./routes/Thankyou.svelte";
	import form from "../mocks/sample.json";

	export let url = "";
</script>

<main>
	<Router {url}>
		<Route path="/">
			<Home {form} />
		</Route>
		<Route path="/:ref" let:params>
			<Form ref={params.ref} {form} />
		</Route>
		<!-- <Route path=":ref" let:params>
			<Thankyou ref={params.ref} {form} />
		</Route> -->
	</Router>
</main>
