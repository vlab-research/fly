<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";

	export let url = "";

	import typeformData from "./typeformData.js";

	const { fields } = typeformData;

	let ref;

	const getCurrentRef = (index) => {
		ref = fields[index].ref;
	};

	const indexUpdate = (e) => {
		const currentIndex = e.detail;

		getCurrentRef(currentIndex);
		console.log(
			`The new index is ${currentIndex} and the new ref is ${ref}`
		);
	};

	const setInitialRef = (index) => {
		ref = fields[index].ref;
		console.log(
			`The starting index is ${index} and the starting ref is ${ref}`
		);
	};
</script>

<main>
	<Router {url}>
		<nav>
			<Link to="/">Home</Link>
			<Link to="/{ref}">Question</Link>
		</nav>
		<Route path="/">
			<Home {setInitialRef} />
		</Route>
		<Route path="/{ref}" let:params>
			<Form {...params} on:indexUpdate={indexUpdate} />
		</Route>
	</Router>
</main>
