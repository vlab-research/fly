<script>
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import { navigate } from "svelte-routing";

    export let ref, fields;

    let index, field;

    $: {
        index = fields.findIndex((field) => field.ref === ref);
        field = fields[index];
    }

    const handleSubmit = () => {
        if (index < fields.length - 1) {
            const newRef = fields[index + 1].ref;
            navigate(`/${newRef}`, { replace: true });
        }
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <!-- Question -->
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
            <button class="btn">OK</button>
        </div>
    </form>
</div>
