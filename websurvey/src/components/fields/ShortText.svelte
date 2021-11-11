<script>
    export let field = {};
    export let index;

    const { title } = field;
    let response = "";
</script>

<!-- Question -->
<div>
    <label for="field-{title}" class="field-label">{title}</label>
    <input
        bind:value={response}
        type="text"
        id="field-{title}"
        autocomplete="off"
        class="input input__lg" />
    <button class="btn">OK</button>
</div>
