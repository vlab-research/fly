<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";
	import Thankyou from "./routes/Thankyou.svelte";
	import typeformData from "./typeformData.js";

	export let url = "";

	const { fields, thankyou_screens } = typeformData;
</script>

<main>
	<Router {url}>
		<Route path="/">
			<Home {fields} />
		</Route>
		<Route path="/:ref" let:params>
			<Form ref={params.ref} {fields} {thankyou_screens} />
		</Route>
		<Route path="/thankyou">
			<Thankyou {thankyou_screens} />
		</Route>
	</Router>
</main>
