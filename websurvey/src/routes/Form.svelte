<script>
    import { navigate } from "svelte-routing";
    import { createEventDispatcher } from "svelte";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import typeformData from "../typeformData.js";

    let dispatch = createEventDispatcher();

    export let ref;

    const { fields } = typeformData;
    const { length } = fields;

    let index = 0;

    let currentField = fields[index];

    const handleSubmit = () => {
        if (index < fields.length - 1) index++;
        currentField = fields[index];
        ref = currentField.ref;
        navigate(`/${ref}`, { replace: true });
        dispatch("updateRef", ref);
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <!-- Question -->
            {#each fields as field (field.id)}
                {#if currentField === field}
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
            {/each}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
