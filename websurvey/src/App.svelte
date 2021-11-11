<script>
	import typeformData from "./typeformData.js";

	const { fields } = typeformData;
	const { length } = fields;
</script>

<main>
	<form>
		<div>
			<!-- Fields -->
			{#each fields as field, index (field.id)}
				<label for="question-0">Question
					{index + 1}
					out of
					{length}</label>
				<li>{field.title}</li>
				<input />
			{/each}
		</div>
	</form>
</main>
