<script>
	import MultipleChoice from "./components/fields/MultipleChoice.svelte";
	import ShortText from "./components/fields/ShortText.svelte";
	import typeformData from "./typeformData.js";

	const { fields } = typeformData;
	const { length } = fields;
</script>

<main>
	<form>
		<div>
			{#each fields as field, index (field.id)}
				<h2>
					<label for="question-0">Question
						{index + 1}
						out of
						{length}</label>
				</h2>
				<!-- Fields -->
				{#if field.type === 'short_text'}
					<ShortText {field} />
				{:else if (field.type = 'multiple_choice')}
					<MultipleChoice {field} />
				{:else}
					<p>You've reached the end of the survey!</p>
				{/if}
			{/each}
		</div>
	</form>
</main>
