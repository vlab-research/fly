<script>
    import { navigate } from "svelte-routing";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import {
        isLast,
        getNextField,
        getThankyouScreen,
    } from "../../lib/typewheels/form.js";
    import {
        validateFieldValue,
        validator,
    } from "../../lib/typewheels/validator.js";
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
        const isValid = validateFieldValue(field, fieldValue, required);
        const res = validator(field)(fieldValue);

        if (index < form.fields.length - 1) {
            if (isValid) {
                const newRef = getNextField(form, qa, ref).ref;
                navigate(`/${newRef}`, { replace: true });
            } else {
                alert(res.message);
            }
        }

        if (isLast(form, ref)) {
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
