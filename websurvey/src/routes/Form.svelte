<script>
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";

    export let ref, fields;

    let index = fields.findIndex((field) => field.ref === ref);

    $: field = fields[index];
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
                        {fields.length}</label>
                </h2>
                {#if field.type === 'short_text'}
                    <ShortText {field} />
                {:else if field.type === 'multiple_choice'}
                    <MultipleChoice {field} />
                {/if}
            {/if}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
