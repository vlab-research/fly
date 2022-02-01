<script>
    import { navigate } from "svelte-routing";
    import MultipleChoice from "../components/MultipleChoice.svelte";
    import ShortText from "../components/ShortText.svelte";
    import { ResponseStore } from "../../lib/typewheels/responseStore.js";
    import { filterFields, translateForm } from "../../lib/typewheels/form.js";
    import Thankyou from "./Thankyou.svelte";

    export let form, ref;

    form = translateForm(form);

    const responseStore = new ResponseStore();

    let index,
        field,
        fieldValue = "",
        required,
        snapshot = responseStore.snapshot(ref, fieldValue),
        qa = responseStore.getQa(snapshot),
        title;

    const addFieldValue = (event) => {
        fieldValue = event.detail;
    };

    $: {
        index = form.fields.map(({ ref }) => ref).indexOf(ref);
        field = form.fields[index];
        required = field.validations ? field.validations.required : null;
        qa = responseStore.getQa(snapshot);
        title = responseStore.interpolate(field, qa);
    }

    const handleSubmit = () => {
        snapshot = responseStore.snapshot(ref, fieldValue);
        qa = responseStore.getQa(snapshot);

        const next = responseStore.next(
            form,
            qa,
            ref,
            field,
            fieldValue,
            required
        );

        if (form.fields.indexOf(field) < form.fields.length - 1) {
            try {
                if (next.action === "error") {
                    throw new SyntaxError(next.error.message);
                }
                navigate(`/${next.ref}`, { replace: true });
            } catch (e) {
                alert(e.message);
            }
        }
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <h2 class="label-wrapper">
                <label for="question-{index + 1}">Question
                    {index + 1}
                    out of
                    {filterFields(form).length}</label>
            </h2>
            {#if field.type === 'short_text' || field.type === 'number'}
                <ShortText
                    {field}
                    {title}
                    bind:fieldValue
                    on:add-field-value={addFieldValue} />
            {:else if field.type === 'multiple_choice'}
                <MultipleChoice
                    {field}
                    {title}
                    bind:fieldValue
                    on:add-field-value={addFieldValue} />
            {:else}
                <Thankyou {field} {title} />
            {/if}
            <button class="btn">OK</button>
        </div>
    </form>
</div>
