<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";
	import typeformData from "./typeformData.js";

	export let url = "";

	const { fields } = typeformData;

	let ref = fields[0].ref;

	const updateRef = (e) => {
		const updatedRef = e.detail;
		ref = updatedRef;
	};
</script>

<main>
	<Router {url}>
		<nav>
			<Link to="/">Home</Link>
			<Link to="/{ref}">Question</Link>
		</nav>
		<Route path="/">
			<Home />
		</Route>
		<Route path="/:ref" let:params>
			<Form ref={params.ref} on:updateRef={updateRef} />
		</Route>
	</Router>
</main>
