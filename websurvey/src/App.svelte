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

	let currentId = getCurrentId(0);

	//TODO set new index on form submit
	let currentIndex = fields.findIndex((field) => field?.id === currentId);

	let ref = fields[currentIndex].ref;
</script>

<main>
	<Router {url}>
		<nav>
			<Link to="/">Home</Link>
			<Link to="/{ref}">Question</Link>
		</nav>
		<Route path="/">
			<Home {ref} />
		</Route>
		<Route path="/{ref}" let:params>
			<Form {...params} {currentIndex} />
		</Route>
	</Router>
</main>
