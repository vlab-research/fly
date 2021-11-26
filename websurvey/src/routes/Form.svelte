<script>
    import { navigate } from "svelte-routing";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import isLast from "../utils/functions/isLast.js";
    import getIndex from "../utils/functions/getIndex.js";
    import getNextRef from "../utils/functions/getNextRef.js";

    export let ref, fields, thankyou_screens;

    let thankyouScreen = thankyou_screens[0];

    let index, field;

    $: {
        index = getIndex(fields, ref);
        field = fields[index];
    }

    const handleSubmit = () => {
        if (index < fields.length - 1) {
            const newRef = getNextRef(fields, ref);
            navigate(`/${newRef}`, { replace: true });
        } else if (isLast(fields, ref)) {
            navigate(`/${thankyouScreen.ref}`, { replace: true });
        }
        return;
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
