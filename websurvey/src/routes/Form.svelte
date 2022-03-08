<script>
    import { navigate } from "svelte-routing";
    import { ResponseStore } from "../../lib/typewheels/responseStore.js";
    import { translateForm, isAQuestion } from "../../lib/typewheels/form.js";
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

        if (form.fields.indexOf(field) < form.fields.length - 1) {
            try {
                if (next.action === "error") {
                    throw new SyntaxError(next.error.message);
                }
                navigate(`/${next.ref}`, { replace: true });
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

<div class="h-screen bg-indigo-50 ">
    <form
        on:submit|preventDefault={handleSubmit}
        class="h-full p-6 max-w-lg mx-auto bg-white rounded-xl shadow-lg flex items-center space-x-4">
        <div class="space-y-4 w-full">
            {#if isAQuestion(form, field)}
                <ProgressBar {form} {field} />
            {/if}
            {#each lookup as option}
                {#if option.type === field.type}
                    {#if !isAQuestion(form, field)}
                        <svelte:component this={option.component} {title} />
                    {:else}
                        <svelte:component
                            this={option.component}
                            {field}
                            {title}
                            bind:fieldValue
                            on:add-field-value={addFieldValue} />
                    {/if}
                {/if}
            {/each}

            <Button>OK</Button>
        </div>
    </form>
</div>
