<script>
	import { Router, Route } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";

	import form from "../mocks/test-1.json";

	export let url = "";
</script>

<style global lang="postcss">
	@tailwind base;
	@tailwind components;
	@tailwind utilities;
</style>

<main>
	<Router {url}>
		<Route path="/">
			<Home {form} />
		</Route>
		<Route path="/:ref" let:params>
			<Form ref={params.ref} {form} />
		</Route>
	</Router>
</main>
