<script>
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import typeformData from "../typeformData.js";

    export let ref;

    const { fields } = typeformData;
    const { length } = fields;

    let index = 0;

    ref = fields[index].ref;

    index = fields.findIndex((field) => field.ref === ref);

    let field = fields[index];
</script>

<div class="surveyapp stack-large">
    <form>
        <div class="stack-small">
            <!-- Question -->
            {#if field}
                <h2 class="label-wrapper">
                    <label for="question-{index + 1}">Question
                        {index + 1}
                        out of
                        {length}</label>
                </h2>
                {#if field.type === 'short_text'}
                    <ShortText {field} />
                {:else if field.type === 'multiple_choice'}
                    <MultipleChoice {field} />
                {:else}
                    <p>You've reached the end of the survey!</p>
                {/if}
            {/if}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
