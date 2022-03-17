<script>
    import { navigate } from "svelte-routing";
    import { ResponseStore } from "../../lib/typewheels/responseStore.js";
    import {
        translateForm,
        isAQuestion,
        _isLast,
    } from "../../lib/typewheels/form.js";
    import MultipleChoice from "../components/form/MultipleChoice.svelte";
    import ShortText from "../components/form/ShortText.svelte";
    import Statement from "../components/form/Statement.svelte";
    import Rating from "../components/form/Rating.svelte";
    import Button from "../components/elements/Button.svelte";
    import ProgressBar from "../components/elements/ProgressBar.svelte";

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

    const resetFieldValue = () => {
        fieldValue = "";
    };

    $: {
        index = form.fields.map(({ ref }) => ref).indexOf(ref);
        field = form.fields[index];
        required = field.validations ? field.validations.required : null;
        qa = responseStore.getQa(snapshot);
        title = responseStore.interpolate(form, field, qa).title;
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

        if (!_isLast(form, ref)) {
            try {
                if (next.action === "error") {
                    throw new SyntaxError(next.error.message);
                }
                navigate(`/${next.ref}`, { replace: false });
                resetFieldValue(fieldValue);
            } catch (e) {
                alert(e.message);
                resetFieldValue(fieldValue);
            }
        }
    };

    const lookup = [
        { type: "short_text", component: ShortText },
        { type: "number", component: ShortText },
        { type: "multiple_choice", component: MultipleChoice },
        { type: "statement", component: Statement },
        { type: "thankyou_screen", component: Statement },
        { type: "rating", component: Rating },
        { type: "opinion_scale", component: Rating },
        { type: "email", component: ShortText },
    ];
</script>

<div class="h-screen bg-indigo-50 flex justify-center">
    <form
        on:submit|preventDefault={handleSubmit}
        class="h-full w-full sm:w-7/12 xl:w-2/5 flex flex-col justify-center p-6 bg-white rounded-xl shadow">
        {#if isAQuestion(form, field)}
            <ProgressBar {form} {field} />
        {/if}
        {#each lookup as option}
            {#if option.type === field.type}
                <svelte:component
                    this={option.component}
                    {field}
                    bind:fieldValue
                    on:add-field-value={addFieldValue} />
            {/if}
        {/each}
        {#if !_isLast(form, ref)}
            <Button />
        {/if}
    </form>
</div>
