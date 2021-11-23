<script>
    import { navigate } from "svelte-routing";
    import { createEventDispatcher } from "svelte";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";

    export let ref;
    export let fields;
    export let thankyou_screens;

    let dispatch = createEventDispatcher();

    const { length } = fields;

    let index = fields.findIndex((field) => field.ref === ref);

    $: field = fields[index];

    let defaultThankyou = thankyou_screens[0];

    const handleSubmit = () => {
        index++;
        if (index < length) {
            field = fields[index];
            ref = field.ref;
            navigate(`/${ref}`, { replace: true });
        } else if (index === length) {
            ref = defaultThankyou.ref;
            navigate(`/${ref}`, { replace: true });
        }
        dispatch("updateRef", ref);
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <!-- Question -->
            {#each fields as currentField}
                {#if field === currentField}
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
                    {/if}
                {/if}
            {/each}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
