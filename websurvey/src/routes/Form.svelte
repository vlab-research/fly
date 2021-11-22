<script>
    import { navigate } from "svelte-routing";
    import { createEventDispatcher } from "svelte";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";

    export let ref;
    export let fields;

    let dispatch = createEventDispatcher();

    const { length } = fields;

    let index = fields.findIndex((field) => field.ref === ref);

    $: field = fields[index];

    const handleSubmit = () => {
        if (index < fields.length - 1) index++;
        field = fields[index];
        ref = field.ref;
        navigate(`/${ref}`, { replace: true });
        dispatch("updateRef", ref);
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
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
