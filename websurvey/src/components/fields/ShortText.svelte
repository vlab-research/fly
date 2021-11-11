<script>
    export let field = {};
    const { title } = field;
    let response = "";
</script>

<!-- Question -->
<div>
    <h3>{title}</h3>
    <input
        bind:value={response}
        type="text"
        id="question-0"
        autocomplete="off" />
    <button>OK</button>
</div>
