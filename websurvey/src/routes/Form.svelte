<script>
    import { navigate } from "svelte-routing";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import {
        isLast,
        getNextRef,
        getThankyouScreen,
    } from "../../lib/typewheels/form.js";

    export let ref, form;

    let index, field;

    $: {
        index = form.fields.map(({ ref }) => ref).indexOf(ref);
        field = form.fields[index];
    }

    const handleSubmit = () => {
        if (index < form.fields.length - 1) {
            const newRef = getNextRef(form, ref);
            navigate(`/${newRef}`, { replace: true });
        } else if (isLast(form, ref)) {
            const thankyouScreen = getThankyouScreen(form, "thankyou");
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
                    {form.fields.length}</label>
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
