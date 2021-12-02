<script>
	import { Router, Route } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";
	import Thankyou from "./routes/Thankyou.svelte";
	import typeformData from "../mocks/typeformData.json";

	export let url = "";
</script>

<main>
	<Router {url}>
		<Route path="/" let:params>
			<Home ref={params.ref} {typeformData} />
		</Route>
		<Route path="/:ref" let:params>
			<Form ref={params.ref} {typeformData} />
		</Route>
		<Route path="/thankyou">
			<Thankyou {typeformData} />
		</Route>
	</Router>
</main>
