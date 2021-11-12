<script>
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import typeformData from "../typeformData.js";

    export let id;
    export let location;

    const { fields } = typeformData;
    const { length } = fields;
</script>

<div class="surveyapp stack-large">
    <form>
        <div class="stack-small">
            <!-- Field -->
            {#each fields as field, index (field.id)}
                <h2 class="label-wrapper">
                    <label for="question-{index}">Question
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
            {/each}
        </div>
    </form>
</div>
