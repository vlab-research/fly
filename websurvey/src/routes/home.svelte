<script>
    import MultipleChoice from "../components/fields/MultipleChoice.svelte";
    import ShortText from "../components/fields/ShortText.svelte";
    import typeformData from "../typeformData.js";

    const { fields } = typeformData;
    const { length } = fields;
    const firstField = fields.filter((field) => fields.indexOf(field) === 0);
</script>

<div class="surveyapp stack-large">
    <form>
        <div class="stack-small">
            <!-- First field -->
            {#each firstField as field, index (field.id)}
                <h2 class="label-wrapper">
                    <label for="question-{index}">Question 1 out of
                        {length}</label>
                </h2>
                {#if field.type === 'short_text'}
                    <ShortText {field} {index} />
                {:else if (field.type = 'multiple_choice')}
                    <MultipleChoice {field} {index} />
                {:else}
                    <p>You've reached the end of the survey!</p>
                {/if}
            {/each}
        </div>
    </form>
</div>
