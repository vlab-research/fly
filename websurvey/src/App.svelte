<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";

	export let url = "";

	import typeformData from "./typeformData.js";

	const { fields } = typeformData;

	let ref;
	let currentIndex = 0;

	const setCurrentRef = (index) => {
		ref = fields[index].ref;
		return ref;
	};

	const indexUpdate = (e) => {
		currentIndex = e.detail;
		setCurrentRef(currentIndex);

		console.log(
			`The current index is ${currentIndex} and the current ref is ${ref}`
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
			<Form {...params} on:indexUpdate={indexUpdate} {currentIndex} />
		</Route>
	</Router>
</main>
