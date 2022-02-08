<script>
    import { navigate } from "svelte-routing";
    import { ResponseStore } from "../../lib/typewheels/responseStore.js";
    import { translateForm } from "../../lib/typewheels/form.js";
    import MultipleChoice from "../components/form/MultipleChoice.svelte";
    import ShortText from "../components/form/ShortText.svelte";
    import Thankyou from "./Thankyou.svelte";
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

    $: {
        index = form.fields.map(({ ref }) => ref).indexOf(ref);
        field = form.fields[index];
        required = field.validations ? field.validations.required : null;
        qa = responseStore.getQa(snapshot);
        title = responseStore.interpolate(field, qa).title;
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

<div class="h-screen bg-indigo-50 ">
    <form
        on:submit|preventDefault={handleSubmit}
        class="h-full p-6 max-w-lg mx-auto bg-white rounded-xl shadow-lg flex items-center space-x-4">
        <div class="space-y-4">
            <ProgressBar {index} {form} />
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

            <Button>OK</Button>
        </div>
    </form>
</div>
