<script>
    import { createEventDispatcher, onMount } from "svelte";
    import { setRequired, ariaRequired } from "../../../lib/typewheels/form.js";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const dispatch = createEventDispatcher();

    const required = field.validations.required;

    let inputElement;

    const inputType = field.type === "email" ? "email" : "text";

    const autocompleteValue = field.type === "email" ? "email" : "off";

    onMount(() => {
        inputElement.type = inputType;
    });
</script>

<Title {field} aria-live="assertive" />
<div class="mb-4">
    <input
        bind:value={fieldValue}
        on:input={dispatch('add-field-value', fieldValue)}
        bind:this={inputElement}
        id="field-{field.id}"
        {required}
        type="text"
        class="max-w-screen-sm focus:ring-indigo-500 focus:border-indigo-500 block pl-2 pr-12 py-2 text-sm md:text-lg border-gray-300 rounded-md w-full md:w-3/4"
        placeholder={field.title}
        autocomplete={autocompleteValue} />
</div>
