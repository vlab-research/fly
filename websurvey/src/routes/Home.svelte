<script>
    import { navigate } from "svelte-routing";

    export let ref;

    const handleSubmit = () => {
        navigate(`/${ref}`, { replace: true });
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <h1 class="h1">Hey! Welcome to our fun survey</h1>
            <button type="submit" class="btn">Let's go</button>
        </div>
    </form>
</div>
