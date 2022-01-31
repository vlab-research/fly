<script>
    import { createEventDispatcher } from "svelte";
    import { ResponseStore } from "../../lib/typewheels/responseStore.js";

    export let field, fieldValue, qa;

    const responseStore = new ResponseStore();

    const dispatch = createEventDispatcher();

    const title = responseStore.interpolationCheck(field, qa);
</script>

<div>
    <label for="field-{field.id}" class="field-label">{title}</label>
    <input
        bind:value={fieldValue}
        on:input={dispatch('add-field-value', fieldValue)}
        type="text"
        id="field-{field.id}"
        autocomplete="off"
        class="input input__lg"
        placeholder={field.title} />
</div>
