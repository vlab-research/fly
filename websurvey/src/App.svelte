<script>
	import { Router, Route, Link } from "svelte-routing";
	import Home from "./routes/Home.svelte";
	import Form from "./routes/Form.svelte";

	export let url = "";

	import typeformData from "./typeformData.js";

	const { fields } = typeformData;

	const getCurrentId = (index) => {
		let id = fields[index].id;
		return id;
	};

	//TODO set new index on form submit
	let currentId = getCurrentId(0);

	let currentIndex = fields.findIndex((field) => field?.id === currentId);

	const getCurrentRef = (index) => {
		let ref = fields[index].ref;
		return ref;
	};

	const ref = getCurrentRef(currentIndex);
</script>

<main>
	<Router {url}>
		<nav>
			<Link to="/">Home</Link>
			<Link to="/{ref}">Question</Link>
		</nav>
		<Route path="/">
			<Home {getCurrentRef} />
		</Route>
		<Route path="/{ref}" let:params>
			<Form {...params} {currentIndex} />
		</Route>
	</Router>
</main>
