<script>
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import typeformData from "../typeformData.js";

    export let currentIndex;

    const { fields } = typeformData;
    const { length } = fields;

    const handleSubmit = () => {
        if (currentIndex < fields.length - 1) {
            currentIndex += 1;
        }
        return currentIndex;
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <!-- Question -->
            {#each fields as field, index (field.id)}
                {#if currentIndex === index}
                    <h2 class="label-wrapper">
                        <label for="question-{index + 1}">Question
                            {index + 1}
                            out of
                            {length}</label>
                    </h2>
                    {#if field.type === 'short_text'}
                        <ShortText {field} />
                    {:else if (field.type = 'multiple_choice')}
                        <MultipleChoice {field} />
                    {:else}
                        <p>You've reached the end of the survey!</p>
                    {/if}
                {/if}
            {/each}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
