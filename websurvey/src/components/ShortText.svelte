<script>
    export let field;

    let response;
</script>

<div>
    <label for="field-{field.id}" class="field-label">{field.title}</label>
    <input
        bind:value={response}
        type="text"
        id="field-{field.id}"
        autocomplete="off"
        class="input input__lg"
        placeholder={field.title} />
</div>
