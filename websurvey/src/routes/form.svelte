<script>
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import Button from "../components/Button.svelte";
    import typeformData from "../typeformData.js";

    const view = "survey";
    const { fields } = typeformData;
    const { length } = fields;
    const field = fields.map((field) => field);

    export let { id } = field;
</script>

<div class="surveyapp stack-large">
    <form>
        <div class="stack-small">
            <!-- Question -->
            {#each fields as field, index (field.id)}
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
            {/each}
            <Button on:surveyClick={(e) => console.log(e.detail)} {view} />
        </div>
    </form>
</div>
