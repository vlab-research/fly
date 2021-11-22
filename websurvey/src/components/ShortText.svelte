<script>
    export let field;

    const { title, id } = field;
    let response;
</script>

<div>
    <label for="field-{id}" class="field-label">{title}</label>
    <input
        bind:value={response}
        type="text"
        id="field-{id}"
        autocomplete="off"
        class="input input__lg"
        placeholder={title} />
</div>
