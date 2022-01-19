<script>
    import { navigate } from "svelte-routing";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import { ResponseStore } from "../../lib/typewheels/responseStore.js";

    export let ref, form;

    let index,
        field,
        fieldValue = " ",
        required;

    const addFieldValue = (event) => {
        fieldValue = event.detail;
    };

    $: {
        index = form.fields.map(({ ref }) => ref).indexOf(ref);
        field = form.fields[index];
        required = field.validations.required;
    }

    const responseStore = new ResponseStore();

    const handleSubmit = () => {
        const snapshot = responseStore.snapshot(ref, fieldValue);
        const qa = responseStore.getQa(snapshot);
        const nextAction = responseStore.nextAction(
            form,
            field,
            fieldValue,
            qa,
            ref,
            required
        );

        try {
            if (nextAction.action === "error") {
                throw new SyntaxError(nextAction.error.message);
            }
            navigate(`/${nextAction.ref}`, { replace: true });
        } catch (e) {
            alert(e.message);
        }

        // TODO move this to the backend
        // if (isLast(form, ref)) {
        //     if (isValid) {
        //         const thankyouScreen = getThankyouScreen(form, "thankyou");
        //         navigate(`/${thankyouScreen.ref}`, { replace: true });
        //     } else {
        //         alert(res.message);
        //     }
        // }
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
            {#if field.type === 'short_text' || field.type === 'number'}
                <ShortText
                    {field}
                    bind:fieldValue
                    on:add-field-value={addFieldValue} />
            {:else if field.type === 'multiple_choice'}
                <MultipleChoice
                    {field}
                    bind:fieldValue
                    on:add-field-value={addFieldValue} />
            {/if}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
